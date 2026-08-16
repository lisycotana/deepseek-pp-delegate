/**
 * The delegate task loop: claim → fresh DS session → execute → settle → delete.
 *
 * This module reuses the same primitives as the automation runner (session
 * create, prompt submit, PoW, tool-continuation loop) but organizes them into
 * a long-running loop rather than a single shot. It does not go through the
 * automation scheduler, because a delegate is "always available" rather than
 * "fires once on a timer" — the scheduler's lease, retry, and 180s timeout
 * semantics all fight that shape.
 *
 * Per-task isolation is the whole point. Each task gets its own DS chat
 * session, created fresh and deleted when the task settles, so one task's
 * context can never leak into the next and the sidebar never accumulates spent
 * conversations. The user's existing manual conversations are never touched
 * because the loop only ever operates on sessions it created.
 *
 * The claim happens at the LOOP level, not inside a DS conversation. This is the
 * key difference from the automation runner: a task is claimed first, then a
 * conversation is created with the mode that fits the task. DeepSeek's web mode
 * is fixed at conversation creation and cannot switch mid-conversation, so the
 * mode must be chosen from the task text before the conversation exists.
 *
 * @module core/delegate/loop
 */

import type { ModelTurn } from '../deepseek/automation-client-port';
import type { ToolCall, ToolExecutionRecord, ToolResult } from '../types';
import { extractToolCalls } from '../interceptor/tool-parser';
import { runToolContinuationLoop } from '../tool-loop/engine';
import { prefelModelType } from './model-pref';
import type {
  DelegateConfig,
  DelegateLoopCallbacks,
  DelegateLoopResult,
  DelegateTaskRecord,
} from './types';

/** Cap on detail/output text length recorded per tool call. */
const DETAIL_MAX = 4_000;
const OUTPUT_MAX = 8_000;

/** Stop reasons a delegate may report. */
const REPORTABLE_STOP_REASONS = ['completed', 'error', 'refusal', 'max-tokens'];

/**
 * Render the call format a delegate must use, with the task's own id filled in.
 */
function settleInstruction(taskId: string): string {
  return [
    'When the work is done, report it with exactly this call — tag name is the tool name, body is JSON:',
    '',
    `<web_task_settle>{"taskId": "${taskId}", "text": "<your full result here>", "stopReason": "completed"}</web_task_settle>`,
    '',
    'If the work failed, send the same call with "stopReason": "error" and put the reason in text.',
    'Do not wrap the call in <invoke>, <tool_call>, <rwscript>, or a markdown code fence — those are ignored and the task will hang.',
  ].join('\n');
}

/**
 * The prompt sent to the fresh DS session, carrying the task and the call format.
 *
 * The task text travels here because that is where the model reads it: right
 * before its first tool call. The call format and the loop contract travel
 * alongside it so a model that improvises a wrapper form is warned at the
 * point of use.
 */
function buildTaskPrompt(task: { id: string; prompt: string; label?: string; cwd?: string }): string {
  const lines = [
    '你是 dsh 的远程执行代理。下面是你的任务，完成后用 web_task_settle 交回结果。',
    '',
    '【工具调用格式 —— 最重要】',
    '只能用「标签名就是工具名」的 XML，标签内是 JSON：',
    '<pwsh>{"command":"Get-ChildItem \'G:\\\\dsh-plugins\'"}</pwsh>',
    '<web_task_settle>{"taskId":"task-xxx","text":"结果","stopReason":"completed"}</web_task_settle>',
    '',
    '以下写法一律无效，会被忽略，任务会卡死：',
    '- 包装标签如 <rwscript><name>pwsh</name>...</rwscript>',
    '- <invoke name="pwsh">...</invoke>',
    '- 把工具调用写在 markdown 代码块里',
    '',
    '【你的任务】',
    task.prompt,
    '',
  ];
  if (task.cwd !== undefined) {
    lines.push(`工作目录：${task.cwd}`, '');
  }
  lines.push(settleInstruction(task.id));
  return lines.join('\n');
}

/**
 * Run the delegate loop until cancelled, errored, or the task cap is hit.
 *
 * Each iteration: claim a task from the bridge → create a fresh DS session
 * with the mode inferred from the task → run the tool loop → the model settles
 * → delete the session. Claiming first means the loop idles patiently when no
 * work is queued, and the mode matches the task.
 * @param config - bounds for the loop.
 * @param callbacks - the background-context dependencies.
 * @returns the loop result with per-task records.
 */
export async function runDelegateLoop(
  config: DelegateConfig,
  callbacks: DelegateLoopCallbacks,
): Promise<DelegateLoopResult> {
  const tasks: DelegateTaskRecord[] = [];
  const startedAt = Date.now();
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 3;

  while (!callbacks.signal.aborted) {
    if (config.maxTasks > 0 && tasks.length >= config.maxTasks) {
      return finish('idle', tasks, startedAt);
    }

    // Claim a task FIRST, before touching the DS API. A task in the queue is
    // proof that real work exists; only then do we spend a DS conversation on
    // it. This lets the loop idle patiently when no work is queued, and lets
    // us pick the model mode from the task text before creating the session.
    const claimed = await callbacks.claimTask(callbacks.signal).catch(() => undefined);
    if (claimed === undefined) {
      // No task arrived during the wait, or the claim was interrupted. Loop
      // back and wait again unless we were cancelled.
      if (callbacks.signal.aborted) {
        return finish('cancelled', tasks, startedAt);
      }
      continue;
    }

    const taskRecord = await runOneTask(config, callbacks, claimed).catch((error) => {
      consecutiveErrors += 1;
      return {
        taskId: claimed.id,
        chatSessionId: '',
        startedAt: Date.now(),
        settledAt: Date.now(),
        stopReason: 'error' as const,
        summary: error instanceof Error ? error.message : String(error),
      } satisfies DelegateTaskRecord;
    });
    tasks.push(taskRecord);

    if (taskRecord.stopReason !== 'error') {
      consecutiveErrors = 0;
    } else if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      return finish('error', tasks, startedAt,
        `Stopped after ${String(consecutiveErrors)} consecutive task failures. Last error: ${taskRecord.summary}`);
    }

    if (callbacks.signal.aborted) {
      return finish('cancelled', tasks, startedAt);
    }
  }

  return finish('cancelled', tasks, startedAt);
}

/**
 * Run one task: create session, submit task prompt, tool loop, settle, delete.
 *
 * The task is already claimed. The model mode is inferred from the task text:
 * DeepSeek's web mode is fixed at conversation creation, so the mode must be
 * chosen before the session exists. `config.modelType` is the fallback when the
 * task text gives no signal; `config.searchEnabled` is the fallback for search.
 * @param config - bounds for the loop.
 * @param callbacks - the background-context dependencies.
 * @param claimed - the task claimed from the bridge.
 * @returns the task record.
 */
async function runOneTask(
  config: DelegateConfig,
  callbacks: DelegateLoopCallbacks,
  claimed: { id: string; prompt: string; label?: string; cwd?: string },
): Promise<DelegateTaskRecord> {
  const clientHeaders = await callbacks.loadClientHeaders();
  if (clientHeaders === null) {
    throw new Error('DS login token is missing; refresh chat.deepseek.com.');
  }

  const startedAt = Date.now();
  const context = { signal: callbacks.signal };

  // Infer the model mode from the task text. The config values are the
  // fallback when the task gives no signal; a per-task signal overrides.
  const pref = prefelModelType(claimed.prompt);
  const modelType = pref.modelType ?? config.modelType;
  const searchEnabled = pref.searchEnabled || config.searchEnabled;
  const thinkingEnabled = modelType === 'expert';

  // A fresh session per task is the isolation contract. The id is never
  // persisted to the automation cursor, so a crashed loop leaves no stale
  // pointer for a retry to resume.
  const chatSessionId = await callbacks.deepSeekClient.createChatSession(clientHeaders, context);
  callbacks.signal.throwIfAborted();

  let stopReason: DelegateTaskRecord['stopReason'] = 'completed';
  let summary = '';

  const taskController = new AbortController();
  const onParentAbort = () => taskController.abort(callbacks.signal.reason);
  callbacks.signal.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => {
    taskController.abort(new Error(`Task exceeded ${String(config.perTaskTimeoutMs)}ms.`));
  }, config.perTaskTimeoutMs);

  try {
    const powHeaders = await callbacks.deepSeekClient.createPowHeaders(clientHeaders, context);
    callbacks.signal.throwIfAborted();

    // Submit the task prompt directly. The task is already claimed, so the
    // model does not call web_task_claim — it sees the task text and starts
    // working. It calls dsh tools over MCP when it needs the machine, then
    // calls web_task_settle with the result.
    const initialTurn = await callbacks.deepSeekClient.submitPrompt({
      chatSessionId,
      parentMessageId: null,
      modelType,
      prompt: callbacks.buildPrompt(buildTaskPrompt(claimed), config.locale),
      refFileIds: [],
      thinkingEnabled,
      searchEnabled,
      clientHeaders,
      powHeaders,
    }, { ...context, signal: taskController.signal });

    if (initialTurn.responseMessageId === null) {
      throw new Error('DeepSeek completion finished without a response message id.');
    }

    await runToolContinuationLoop<ModelTurn>({
      initialTurn,
      maxDepth: config.toolLoopDepth,
      getAssistantText: (turn) => turn.assistantText,
      getParentMessageId: (turn) => turn.responseMessageId,
      extractToolCalls: (text) => extractToolCalls(text, { descriptors: callbacks.toolDescriptors }),
      executeToolCall: (call, parentMessageId) =>
        executeOneToolCall(callbacks, call, chatSessionId, parentMessageId, taskController.signal),
      buildContinuationPrompt: (executions) => buildContinuation(executions),
      submitContinuation: async (prompt, parentMessageId) => {
        const pow = await callbacks.deepSeekClient.createPowHeaders(clientHeaders, context);
        return callbacks.deepSeekClient.submitPrompt({
          chatSessionId,
          parentMessageId,
          modelType,
          prompt,
          refFileIds: [],
          thinkingEnabled,
          searchEnabled,
          clientHeaders,
          powHeaders: pow,
        }, { ...context, signal: taskController.signal });
      },
      signal: taskController.signal,
      assertActive: () => {
        if (callbacks.signal.aborted) {
          throw callbacks.signal.reason instanceof Error
            ? callbacks.signal.reason
            : new DOMException('Delegate loop cancelled.', 'AbortError');
        }
      },
    });
  } catch (error) {
    if (taskController.signal.aborted && callbacks.signal.aborted) {
      stopReason = 'aborted';
      summary = 'cancelled';
    } else {
      stopReason = 'error';
      summary = error instanceof Error ? error.message : String(error);
    }
  } finally {
    clearTimeout(timer);
    callbacks.signal.removeEventListener('abort', onParentAbort);

    // Deletion is best-effort: the client swallows server errors for missing
    // sessions. A failure here does not affect the settled result.
    await callbacks.deepSeekClient.deleteChatSession(chatSessionId, clientHeaders, {
      signal: callbacks.signal,
    }).catch(() => undefined);
  }

  return {
    taskId: claimed.id,
    chatSessionId,
    startedAt,
    settledAt: Date.now(),
    stopReason,
    summary,
  };
}

/**
 * Execute one tool call through the background registry and wrap it as a record.
 * @param callbacks - the background-context dependencies.
 * @param call - the parsed tool call.
 * @param chatSessionId - the owning DS session.
 * @param parentMessageId - the DS message id to continue from.
 * @param signal - the task's cancellation signal.
 * @returns the tool execution record.
 */
async function executeOneToolCall(
  callbacks: DelegateLoopCallbacks,
  call: ToolCall,
  chatSessionId: string,
  parentMessageId: number,
  signal: AbortSignal,
): Promise<ToolExecutionRecord> {
  const result: ToolResult = await callbacks.executeToolCall(call, {
    signal,
    idempotencyKey: `delegate:${chatSessionId}:${parentMessageId}:${call.name}`,
  });
  return {
    name: result.name ?? call.name,
    provider: result.provider ?? call.provider,
    descriptorId: result.descriptorId ?? call.descriptorId,
    result: {
      ok: result.ok,
      name: result.name,
      provider: result.provider,
      descriptorId: result.descriptorId,
      summary: result.summary,
      detail: clampText(result.detail, DETAIL_MAX),
      output: result.output === undefined ? undefined : clampText(JSON.stringify(result.output), OUTPUT_MAX),
      truncated: result.truncated,
      error: result.error,
    },
  };
}

/**
 * Build the continuation prompt that hands tool results back to the model.
 * @param executions - the tool calls executed this round.
 * @returns the continuation prompt text.
 */
function buildContinuation(executions: readonly ToolExecutionRecord[]): string {
  const lines = ['以下是工具执行结果。基于结果继续完成任务。', ''];
  for (const execution of executions) {
    lines.push(`<tool_result name="${execution.name}">`);
    if (execution.result.summary) lines.push(`summary: ${execution.result.summary}`);
    if (execution.result.detail) lines.push(`detail: ${execution.result.detail}`);
    if (execution.result.error) lines.push(`error: ${execution.result.error}`);
    lines.push('</tool_result>');
  }
  return lines.join('\n');
}

/**
 * Truncate text to a maximum length with an ellipsis marker.
 * @param value - the text to clamp.
 * @param max - the maximum length.
 * @returns the clamped text.
 */
function clampText(value: string | undefined, max: number): string | undefined {
  if (!value) return value;
  return value.length > max ? `${value.slice(0, max)}\n...[truncated]` : value;
}

/**
 * Assemble the final loop result.
 * @param stopReason - why the loop stopped.
 * @param tasks - per-task records.
 * @param startedAt - when the loop began.
 * @param error - optional error message.
 * @returns the loop result.
 */
function finish(
  stopReason: DelegateLoopResult['stopReason'],
  tasks: readonly DelegateTaskRecord[],
  startedAt: number,
  error?: string,
): DelegateLoopResult {
  return { stopReason, tasks, stoppedAt: Date.now(), error };
}

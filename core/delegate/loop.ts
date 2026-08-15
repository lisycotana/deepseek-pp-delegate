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
 * @module core/delegate/loop
 */

import type { ModelTurn } from '../deepseek/automation-client-port';
import type { ToolCall, ToolExecutionRecord, ToolResult } from '../types';
import { extractToolCalls } from '../interceptor/tool-parser';
import { runToolContinuationLoop } from '../tool-loop/engine';
import type {
  DelegateConfig,
  DelegateLoopCallbacks,
  DelegateLoopResult,
  DelegateTaskRecord,
} from './types';

/** Cap on detail/output text length recorded per tool call. */
const DETAIL_MAX = 4_000;
const OUTPUT_MAX = 8_000;

/**
 * The first prompt sent to each fresh DS session.
 *
 * The model reads this before its first tool call, so the call format and the
 * loop contract travel here. Browser-side clients execute the direct
 * tool-name XML tag form and silently ignore anything else, so a model that
 * improvises a wrapper produces a turn with no tool call and the task stalls;
 * the reminder names the wrapper forms to avoid.
 */
const DELEGATE_BOOT_PROMPT = [
  '你是 dsh 的远程执行代理。dsh 会派任务给你，你做完交回去。',
  '',
  '【工具调用格式 —— 最重要】',
  '只能用「标签名就是工具名」的 XML，标签内是 JSON：',
  '<web_task_claim>{}</web_task_claim>',
  '<pwsh>{"command":"Get-ChildItem \'G:\\\\dsh-plugins\'"}</pwsh>',
  '<web_task_settle>{"taskId":"task-xxx","text":"结果","stopReason":"completed"}</web_task_settle>',
  '',
  '以下写法一律无效，会被忽略，任务会卡死：',
  '- 包装标签如 <rwscript><name>pwsh</name>...</rwscript>',
  '- <invoke name="pwsh">...</invoke>',
  '- 把工具调用写在 markdown 代码块里',
  '',
  '【循环】',
  '1. 发 <web_task_claim>{}</web_task_claim> 领任务。',
  '2. 返回「No task available.」就立刻再发一次。',
  '3. 领到任务后，用 pwsh / glob / read / write / edit / grep 等工具完成它。',
  '4. 做完发 web_task_settle，taskId 用任务里给的那个，text 写完整结果。',
  '5. settle 的返回值里通常直接带着下一个任务，有的话接着做；没有就回第 1 步。',
  '',
  '每一轮回复都必须包含至少一个工具标签。不要问「要继续吗」，直接调。',
  '失败也要交：用 stopReason error，把原因写进 text。绝不能不交。',
].join('\n');

/**
 * Run the delegate loop until cancelled, errored, or the task cap is hit.
 *
 * Each iteration is one task: a fresh session is created, the boot prompt is
 * submitted, the tool-continuation loop runs, and the session is deleted in a
 * finally block regardless of outcome. A task that fails to settle is still
 * cleaned up; the dsh side times out its own claim and moves on.
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

  while (!callbacks.signal.aborted) {
    if (config.maxTasks > 0 && tasks.length >= config.maxTasks) {
      return finish('idle', tasks, startedAt);
    }

    const taskRecord = await runOneTask(config, callbacks).catch((error) => {
      // A task-level failure does not abort the loop: the next iteration gets a
      // fresh session and a fresh claim. Only auth loss or cancellation stops it.
      return {
        taskId: null,
        chatSessionId: '',
        startedAt: Date.now(),
        settledAt: Date.now(),
        stopReason: 'error' as const,
        summary: error instanceof Error ? error.message : String(error),
      } satisfies DelegateTaskRecord;
    });
    tasks.push(taskRecord);

    // Auth loss is terminal: retrying immediately would fail the same way.
    if (taskRecord.stopReason === 'aborted' && callbacks.signal.aborted) {
      return finish('cancelled', tasks, startedAt);
    }
  }

  return finish('cancelled', tasks, startedAt);
}

/**
 * Run one task: create session, boot, tool loop, settle, delete.
 * @param config - bounds for the loop.
 * @param callbacks - the background-context dependencies.
 * @returns the task record.
 */
async function runOneTask(
  config: DelegateConfig,
  callbacks: DelegateLoopCallbacks,
): Promise<DelegateTaskRecord> {
  const clientHeaders = await callbacks.loadClientHeaders();
  if (clientHeaders === null) {
    throw new Error('DS login token is missing; refresh chat.deepseek.com.');
  }

  const startedAt = Date.now();
  const context = { signal: callbacks.signal };

  // A fresh session per task is the isolation contract. The id is never
  // persisted to the automation cursor, so a crashed loop leaves no stale
  // pointer for a retry to resume.
  const chatSessionId = await callbacks.deepSeekClient.createChatSession(clientHeaders, context);
  callbacks.signal.throwIfAborted();

  let taskId: string | null = null;
  let stopReason: DelegateTaskRecord['stopReason'] = 'completed';
  let summary = '';

  const taskController = new AbortController();
  const onParentAbort = () => taskController.abort(callbacks.signal.reason);
  callbacks.signal.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => {
    taskController.abort(new Error(`Task exceeded ${String(config.perTaskTimeoutMs)}ms.`));
  }, config.perTaskTimeoutMs);

  try {
    // The boot prompt teaches the loop and the call format. The model's first
    // action is to call web_task_claim, which holds open until dsh queues work.
    const powHeaders = await callbacks.deepSeekClient.createPowHeaders(clientHeaders, context);
    callbacks.signal.throwIfAborted();

    const initialTurn = await callbacks.deepSeekClient.submitPrompt({
      chatSessionId,
      parentMessageId: null,
      modelType: null,
      prompt: callbacks.buildPrompt(DELEGATE_BOOT_PROMPT, config.locale),
      refFileIds: [],
      thinkingEnabled: false,
      searchEnabled: false,
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
          modelType: null,
          prompt,
          refFileIds: [],
          thinkingEnabled: false,
          searchEnabled: false,
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
    taskId,
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
 * @returns the loop result.
 */
function finish(
  stopReason: DelegateLoopResult['stopReason'],
  tasks: readonly DelegateTaskRecord[],
  startedAt: number,
): DelegateLoopResult {
  return { stopReason, tasks, stoppedAt: Date.now() };
}

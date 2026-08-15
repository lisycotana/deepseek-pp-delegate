/**
 * Types for the dsh delegate: a long-running loop that turns a DeepSeek web
 * conversation into an execution worker for DeepSeek Harness.
 *
 * Unlike an automation run (single-shot, scheduled), a delegate loop waits for
 * work: each iteration claims a task from dsh, runs it in a fresh DS chat
 * session, settles the result, and deletes the session — so task contexts never
 * bleed into each other and the sidebar never accumulates spent conversations.
 *
 * @module core/delegate/types
 */

import type { ToolCall, ToolDescriptor, ToolResult } from '../types';
import type { DeepSeekAutomationClient, DeepSeekRequestContext } from '../deepseek/automation-client-port';

/** How a delegate run ended. */
export type DelegateStopReason =
  | 'idle'          // maxTasks reached or queue exhausted
  | 'cancelled'     // caller stopped the loop
  | 'error'         // an unrecoverable failure
  | 'auth';         // DS login token lost mid-loop

/** One task's lifecycle outcome, recorded for diagnostics. */
export interface DelegateTaskRecord {
  readonly taskId: string | null;
  readonly chatSessionId: string;
  readonly startedAt: number;
  readonly settledAt: number | null;
  readonly stopReason: 'completed' | 'error' | 'aborted';
  readonly summary: string;
}

/** The result a delegate loop returns when it stops. */
export interface DelegateLoopResult {
  readonly stopReason: DelegateStopReason;
  readonly tasks: readonly DelegateTaskRecord[];
  readonly stoppedAt: number;
  readonly error?: string;
}

/** Configurable bounds for one delegate loop. */
export interface DelegateConfig {
  /** Hard ceiling on tasks before the loop stops idle. 0 = unbounded. */
  readonly maxTasks: number;
  /** Wall-clock limit for one task's execution, including tool calls. */
  readonly perTaskTimeoutMs: number;
  /** Tool-loop depth per task. Each round = one assistant turn of tool calls. */
  readonly toolLoopDepth: number;
  /** Locale for prompt augmentation. */
  readonly locale: string;
}

export const DEFAULT_DELEGATE_CONFIG: DelegateConfig = {
  // A delegate is meant to stay available, but an unbounded loop with no exit
  // is a service-worker-termination magnet. A high cap lets it run a real
  // session while still terminating when the work dries up.
  maxTasks: 100,
  perTaskTimeoutMs: 1_800_000,
  // One task's claim → work → settle fits in few rounds because settle hands
  // the next task over inline; depth covers a multi-tool task.
  toolLoopDepth: 12,
  locale: 'zh-CN',
};

/** Callbacks the loop needs from the background context. */
export interface DelegateLoopCallbacks {
  readonly deepSeekClient: DeepSeekAutomationClient;
  /** Execute one parsed tool call through the production registry. */
  readonly executeToolCall: (
    call: ToolCall,
    options: { signal: AbortSignal; idempotencyKey: string },
  ) => Promise<ToolResult>;
  /** Tool descriptors advertised to the model (MCP + web tools). */
  readonly toolDescriptors: readonly ToolDescriptor[];
  /** Fresh client headers, refreshed if the cached ones are stale. */
  readonly loadClientHeaders: () => Promise<Record<string, string> | null>;
  /** Build the prompt augmentation (memories, preset, project, tools). */
  readonly buildPrompt: (prompt: string, locale: string) => string;
  /** Signal the loop was cancelled externally. */
  readonly signal: AbortSignal;
}

/** Per-request context for one DS API call inside the loop. */
export type DelegateRequestContext = DeepSeekRequestContext;

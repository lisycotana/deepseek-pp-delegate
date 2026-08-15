/**
 * Background-side controller for the delegate loop: owns the single live run,
 * wires the loop's callbacks to the production tool registry and DS client,
 * and surfaces status to the UI.
 *
 * One delegate run is allowed at a time. A second start while one is live is
 * refused with an explanatory error rather than queued — a delegate is a
 * stateful long runner, and queuing two would just deadlock the second on the
 * first's abort.
 *
 * @module entrypoints/background/delegate-controller
 */

import type { ToolCall, ToolResult } from '../../core/types';
import type { DelegateConfig, DelegateLoopResult } from '../../core/delegate/types';
import { runDelegateLoop } from '../../core/delegate/loop';
import { buildPromptAugmentation } from '../../core/prompt/augmentation';
import type { DeepSeekAutomationClient } from '../../core/deepseek/automation-client-port';

/** Dependencies the controller needs from the background context. */
export interface DelegateControllerDependencies {
  readonly deepSeekClient: DeepSeekAutomationClient;
  readonly loadClientHeaders: () => Promise<Record<string, string> | null>;
  readonly getToolDescriptors: (locale: string) => Promise<readonly import('../../core/types').ToolDescriptor[]>;
  readonly executeToolCall: (
    call: ToolCall,
    options: { signal: AbortSignal; idempotencyKey: string },
  ) => Promise<ToolResult>;
}

/** The controller surface returned by {@link createDelegateController}. */
export interface DelegateController {
  start(config: DelegateConfig): { ok: true; runId: string } | { ok: false; error: string };
  stop(): Promise<void>;
  getStatus(): DelegateStatus;
}

/** Mutable status of the delegate loop, read by the UI. */
interface DelegateStatus {
  running: boolean;
  runId?: string;
  tasksCompleted: number;
  lastError?: string;
  lastStoppedAt?: number;
}

/** The single live run's handle, or null when idle. */
interface ActiveRun {
  runId: string;
  controller: AbortController;
  result: Promise<DelegateLoopResult>;
}

/**
 * Create a delegate controller bound to one set of dependencies.
 * @param deps - the background-context dependencies.
 * @returns the controller surface.
 */
export function createDelegateController(deps: DelegateControllerDependencies): DelegateController {
  let active: ActiveRun | null = null;
  let status: DelegateStatus = { running: false, tasksCompleted: 0 };

  /**
   * Start a delegate loop. Refuses if one is already running.
   * @param config - bounds for the loop.
   * @returns `{ ok, runId }` or `{ ok: false, error }`.
   */
  function start(config: DelegateConfig): { ok: true; runId: string } | { ok: false; error: string } {
    if (active !== null) {
      return { ok: false, error: 'A delegate loop is already running. Stop it first.' };
    }
    const runId = `delegate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const controller = new AbortController();

    status = { running: true, runId, tasksCompleted: 0 };

    const callbacks = {
      deepSeekClient: deps.deepSeekClient,
      executeToolCall: deps.executeToolCall,
      // Tool descriptors are loaded once per loop start; a mid-loop MCP server
      // change is rare and the model re-discovers on the next loop start.
      toolDescriptors: [] as readonly import('../../core/types').ToolDescriptor[],
      loadClientHeaders: deps.loadClientHeaders,
      buildPrompt: (prompt: string, locale: string) =>
        // The config locale is a free string; the augmentation accepts the two
        // supported locales and falls back to default for anything else.
        buildPromptAugmentation(prompt, { locale: locale as 'en' | 'zh-CN' }).augmented,
      signal: controller.signal,
    };

    // Descriptor load is async but the loop needs them synchronously at first
    // call; load before the loop starts, then the loop reads the populated array.
    const result = deps.getToolDescriptors(config.locale).then(async (descriptors) => {
      callbacks.toolDescriptors = descriptors;
      return runDelegateLoop(config, callbacks);
    });

    active = { runId, controller, result };

    // Resolve in the background and update status; the caller does not await.
    result.then((loopResult) => {
      status = {
        running: false,
        runId,
        tasksCompleted: loopResult.tasks.length,
        lastError: loopResult.stopReason === 'error' ? loopResult.error : undefined,
        lastStoppedAt: loopResult.stoppedAt,
      };
      active = null;
    }).catch((error) => {
      status = {
        running: false,
        runId,
        tasksCompleted: 0,
        lastError: error instanceof Error ? error.message : String(error),
        lastStoppedAt: Date.now(),
      };
      active = null;
    });

    return { ok: true, runId };
  }

  /**
   * Stop the live delegate loop. No-op if none is running.
   * @returns when the stop has been requested.
   */
  async function stop(): Promise<void> {
    if (active === null) return;
    active.controller.abort(new Error('Delegate loop stopped by user.'));
    // Wait for the loop to settle so the status reflects the stop.
    await active.result.catch(() => undefined);
  }

  /**
   * Read the current delegate status.
   * @returns a snapshot of the loop's state.
   */
  function getStatus(): DelegateStatus {
    return { ...status };
  }

  return { start, stop, getStatus };
}

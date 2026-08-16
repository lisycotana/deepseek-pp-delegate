/**
 * Runtime command handlers for the delegate loop: start, stop, and status.
 *
 * @module entrypoints/background/delegate-handlers
 */

import {
  definePayloadlessRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from '../../core/messaging/runtime-command-registry';
import type { BackgroundRuntimeDecodedPayload } from '../../core/messaging/background-runtime-request-codec';
import { defineBackgroundPayloadRuntimeCommandHandler } from './runtime-handler';
import { DEFAULT_DELEGATE_CONFIG } from '../../core/delegate/types';
import type { DelegateController } from './delegate-controller';

/** Dependencies the handlers need. */
export interface DelegateHandlerDependencies {
  readonly delegateController: DelegateController;
}

/**
 * Create the delegate runtime command handlers.
 * @param deps - the controller surface.
 * @returns the handler array.
 */
export function createDelegateHandlers(
  deps: DelegateHandlerDependencies,
): readonly RuntimeCommandHandler[] {
  return Object.freeze([
    defineBackgroundPayloadRuntimeCommandHandler('START_DELEGATE', (payload: BackgroundRuntimeDecodedPayload<'START_DELEGATE'>) => {
      const config = { ...DEFAULT_DELEGATE_CONFIG };
      if (payload.maxTasks !== undefined) config.maxTasks = payload.maxTasks;
      if (payload.modelType !== undefined) config.modelType = payload.modelType;
      if (payload.searchEnabled !== undefined) config.searchEnabled = payload.searchEnabled;
      const result = deps.delegateController.start(config);
      return Promise.resolve(result);
    }),
    definePayloadlessRuntimeCommandHandler('STOP_DELEGATE', () => (
      deps.delegateController.stop().then(() => ({ ok: true as const }))
    )),
    definePayloadlessRuntimeCommandHandler('GET_DELEGATE_STATUS', () => (
      Promise.resolve(deps.delegateController.getStatus())
    )),
  ]);
}

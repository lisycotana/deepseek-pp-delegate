/**
 * Credential pusher: periodically pushes DS web credentials to an external
 * API proxy (deepseek-free-api) so the proxy can call DS API directly.
 *
 * The DS++ extension holds the user's live login state (cookies + bearer).
 * Rather than requiring the proxy to scrape or manually capture credentials,
 * the extension pushes them to the proxy's POST /credentials endpoint every
 * few minutes and on SW wake. The proxy caches them — no manual config.
 *
 * @module core/deepseek/credential-pusher
 */

import { exportDsCredentials } from './credential-export';

/** Default push interval: 5 minutes. */
const PUSH_INTERVAL_MS = 5 * 60 * 1000;

/** Default proxy URL (deepseek-free-api listening on localhost:3000). */
const DEFAULT_PROXY_URL = 'http://127.0.0.1:3000/credentials';

export interface CredentialPusherConfig {
  /** The proxy's /credentials endpoint. */
  readonly proxyUrl: string;
  /** Bearer token for the push endpoint (must match PUSH_TOKEN on the proxy). */
  readonly pushToken?: string;
  /** Push interval in ms. */
  readonly intervalMs: number;
}

export interface CredentialPusher {
  /** Start the periodic push. Returns a disposer. */
  start(): () => void;
  /** Push once immediately. */
  pushNow(): Promise<void>;
}

/**
 * Create a credential pusher.
 *
 * The pusher reads credentials via exportDsCredentials and POSTs them to the
 * proxy. A failed push is silent — the proxy falls back to its file source,
 * and the next interval retries.
 * @param config - the pusher config.
 * @returns the pusher surface.
 */
export function createCredentialPusher(config: CredentialPusherConfig): CredentialPusher {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  async function pushOnce(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const creds = await exportDsCredentials();
      if (creds === null) return;

      await fetch(config.proxyUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.pushToken ? { authorization: `Bearer ${config.pushToken}` } : {}),
        },
        body: JSON.stringify(creds),
      });
    } catch {
      // The proxy might be down. Silent — next interval retries.
    } finally {
      running = false;
    }
  }

  return {
    start() {
      // Push once on start, then on interval.
      void pushOnce();
      timer = setInterval(() => { void pushOnce(); }, config.intervalMs);
      return () => {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    async pushNow() {
      await pushOnce();
    },
  };
}

/** Default config values for the pusher. */
export const DEFAULT_PUSHER_CONFIG: Pick<CredentialPusherConfig, 'proxyUrl' | 'intervalMs'> = {
  proxyUrl: DEFAULT_PROXY_URL,
  intervalMs: PUSH_INTERVAL_MS,
};

/**
 * Credential export: reads DS web login credentials (cookie + bearer + UA)
 * from the browser context for use by an external API proxy.
 *
 * The DS++ extension runs in a browser where the user is already logged into
 * chat.deepseek.com. The browser holds the session cookies and the token.
 * This module reads both and returns them in a shape an external HTTP client
 * can use directly — no manual scraping, no Playwright, no token files.
 *
 * Cookie: read via chrome.cookies.getAll (available in the SW).
 * Bearer: read from chrome.storage.local where DS++ caches the token
 * (the SW has no localStorage; the token is captured by the content script
 * on chat.deepseek.com and relayed to the SW via rememberDeepSeekClientHeaders).
 *
 * @module core/deepseek/credential-export
 */

/** Credentials returned to an external caller. */
export interface DsCredentials {
  /** DS session cookies as a `name=value; name=value` string for the Cookie header. */
  readonly cookie: string;
  /** The bearer token from the Authorization header, for the Authorization header. */
  readonly bearer: string;
  /** The browser's User-Agent, so the proxy's requests match the browser's. */
  readonly userAgent: string;
}

const DS_DOMAIN = 'chat.deepseek.com';

/** chrome.storage.local key where DS++ caches the client headers (incl. Authorization). */
const STORAGE_HEADERS_KEY = 'deepseekCachedClientHeaders';

/**
 * Read the DS bearer token from chrome.storage.local.
 *
 * DS++ caches the full client headers (Authorization, x-client-version, etc.)
 * under `deepseekCachedClientHeaders`. The content script on chat.deepseek.com
 * reads the token from localStorage and relays it here; the SW itself has no
 * localStorage, so this is the only way to reach the token from the SW.
 * @returns the bearer token (without "Bearer " prefix), or null.
 */
async function readBearerToken(): Promise<string | null> {
  try {
    const data = await chrome.storage.local.get(STORAGE_HEADERS_KEY);
    const headers = data[STORAGE_HEADERS_KEY] as Record<string, string> | undefined;
    if (!headers) return null;
    const auth = headers.Authorization || headers.authorization;
    if (!auth) return null;
    // Strip "Bearer " prefix if present.
    return auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  } catch {
    return null;
  }
}

/**
 * Read DS cookies from the browser's cookie store and format them as a
 * `name=value; name=value` string.
 * @returns the cookie header value, or empty string when none found.
 */
async function readCookieString(): Promise<string> {
  try {
    const cookies = await chrome.cookies.getAll({ domain: DS_DOMAIN });
    if (cookies.length === 0) return '';
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

/**
 * Export the current DS web credentials.
 *
 * Call this from the background service worker. Returns null when the user
 * is not logged in (no token + no cookies).
 * @returns the credentials, or null when unavailable.
 */
export async function exportDsCredentials(): Promise<DsCredentials | null> {
  const [cookie, bearer] = await Promise.all([
    readCookieString(),
    readBearerToken(),
  ]);

  if (!cookie && !bearer) return null;

  return {
    cookie,
    bearer: bearer ?? '',
    userAgent: navigator.userAgent,
  };
}

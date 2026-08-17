/**
 * Credential export: reads DS web login credentials (cookie + bearer + UA)
 * from the browser context for use by an external API proxy.
 *
 * The DS++ extension runs in a browser where the user is already logged into
 * chat.deepseek.com. The browser holds the session cookies and localStorage
 * token. This module reads both and returns them in a shape an external HTTP
 * client can use directly — no manual scraping, no Playwright, no token files.
 *
 * @module core/deepseek/credential-export
 */

/** Credentials returned to an external caller. */
export interface DsCredentials {
  /** DS session cookies as a `name=value; name=value` string for the Cookie header. */
  readonly cookie: string;
  /** The bearer token from localStorage, for the Authorization header. */
  readonly bearer: string;
  /** The browser's User-Agent, so the proxy's requests match the browser's. */
  readonly userAgent: string;
}

const DS_DOMAIN = 'chat.deepseek.com';
const USER_TOKEN_STORAGE_KEY = 'userToken';

/**
 * Read the DS bearer token from localStorage.
 *
 * Mirrors `readDeepSeekUserToken` in active-client.ts — the token is stored
 * under the `userToken` key, either as a plain string or as a JSON object
 * with a `token`/`value`/`accessToken` field.
 * @returns the token, or null when not found.
 */
function readBearerToken(): string | null {
  try {
    const raw = localStorage.getItem(USER_TOKEN_STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') return parsed.trim() || null;
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        const token = obj.token ?? obj.value ?? obj.accessToken;
        if (typeof token === 'string') return token.trim() || null;
      }
    } catch {
      // Not JSON — treat as a raw string.
    }
    if (raw.trim() === 'null') return null;
    return raw.trim() || null;
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
 * Call this from the background service worker (where `chrome.cookies` is
 * available). Returns null when the user is not logged in (no token + no
 * cookies).
 * @returns the credentials, or null when unavailable.
 */
export async function exportDsCredentials(): Promise<DsCredentials | null> {
  const [cookie, bearer] = await Promise.all([
    readCookieString(),
    Promise.resolve(readBearerToken()),
  ]);

  if (!cookie && !bearer) return null;

  return {
    cookie,
    bearer: bearer ?? '',
    userAgent: navigator.userAgent,
  };
}

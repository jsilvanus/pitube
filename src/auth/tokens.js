import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEVICE_URL = 'https://oauth2.googleapis.com/device/code';
export const SCOPE = 'https://www.googleapis.com/auth/youtube';
const DAY = 86_400_000;

/**
 * OAuth tokens for YouTube. They live only here (a 0600 file) and never leave
 * through the API; `health()` reports state and age only.
 */
export function createTokenService({ config, events, fetch = globalThis.fetch, now = () => Date.now() }) {
  let state = null; // { refreshToken, accessToken, expiresAt, obtainedAt }
  let lastError = null;
  let lastRefreshAt = null;
  let lastHealth = 'missing';
  let refreshing = null;
  let device = null; // pending device sign-in

  async function load() {
    if (state) return state;
    try {
      state = JSON.parse(await readFile(config.tokenFile, 'utf8'));
    } catch {
      state = null;
    }
    if (!state && config.refreshToken) {
      state = { refreshToken: config.refreshToken, accessToken: null, expiresAt: 0, obtainedAt: now() };
    }
    return state;
  }

  async function save() {
    await mkdir(dirname(config.tokenFile), { recursive: true });
    const tmp = `${config.tokenFile}.tmp`;
    await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await rename(tmp, config.tokenFile);
  }

  async function post(url, params) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, body };
  }

  function setHealth(next) {
    if (next !== lastHealth) {
      lastHealth = next;
      events?.publish('auth.health', { state: next });
    }
  }

  async function refresh() {
    const s = await load();
    if (!s?.refreshToken) {
      setHealth('missing');
      throw Object.assign(new Error('YouTube is not signed in'), { code: 'auth_missing' });
    }
    const r = await post(TOKEN_URL, {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: s.refreshToken,
      grant_type: 'refresh_token',
    });
    if (!r.ok) {
      const revoked = r.body.error === 'invalid_grant';
      lastError = r.body.error_description || r.body.error || `HTTP ${r.status}`;
      setHealth(revoked ? 'revoked' : 'refresh_failed');
      throw Object.assign(new Error(`Token refresh failed: ${lastError}`), {
        code: revoked ? 'auth_revoked' : 'auth_refresh_failed',
      });
    }
    s.accessToken = r.body.access_token;
    s.expiresAt = now() + (r.body.expires_in ?? 3600) * 1000;
    if (r.body.refresh_token) s.refreshToken = r.body.refresh_token;
    lastRefreshAt = now();
    lastError = null;
    await save().catch(() => {});
    setHealth('ok');
    return s;
  }

  /** A valid access token, refreshed when it expires within a minute. */
  async function getAccessToken() {
    const s = await load();
    if (s?.accessToken && s.expiresAt - now() > 60_000) return s.accessToken;
    refreshing ??= refresh().finally(() => { refreshing = null; });
    return (await refreshing).accessToken;
  }

  /** Force a refresh so a dead sign-in shows up before Sunday, not during it. */
  async function check() {
    try {
      await refresh();
    } catch { /* recorded in health */ }
    return health();
  }

  async function health() {
    const s = await load();
    const ageDays = s ? Math.floor((now() - (s.obtainedAt ?? now())) / DAY) : null;
    const warnings = [];
    if (s && ageDays >= config.tokenWarnDays) {
      warnings.push(`sign-in is ${ageDays} days old; sign in again if the Google app is in testing mode (tokens expire after 7 days)`);
    }
    return {
      state: s ? (lastHealth === 'missing' ? 'unchecked' : lastHealth) : 'missing',
      signedIn: Boolean(s?.refreshToken),
      signedInAgeDays: ageDays,
      lastRefreshAt: lastRefreshAt ? new Date(lastRefreshAt).toISOString() : null,
      accessTokenExpiresAt: s?.expiresAt ? new Date(s.expiresAt).toISOString() : null,
      lastError,
      warnings,
    };
  }

  /** Step 1 of the device sign-in: the user opens the URL on a phone and types the code. */
  async function startDeviceAuth() {
    if (!config.clientId) throw Object.assign(new Error('YOUTUBE_CLIENT_ID is not set'), { code: 'config' });
    const r = await post(DEVICE_URL, { client_id: config.clientId, scope: SCOPE });
    if (!r.ok) throw new Error(`Device sign-in failed: ${r.body.error || r.status}`);
    device = { code: r.body.device_code, expiresAt: now() + r.body.expires_in * 1000, interval: r.body.interval ?? 5 };
    return {
      verificationUrl: r.body.verification_url,
      userCode: r.body.user_code,
      expiresInSeconds: r.body.expires_in,
      intervalSeconds: device.interval,
    };
  }

  /** Step 2: poll until the user approved. */
  async function pollDeviceAuth() {
    if (!device || device.expiresAt < now()) {
      device = null;
      return { status: 'expired' };
    }
    const r = await post(TOKEN_URL, {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      device_code: device.code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (r.ok) {
      state = {
        refreshToken: r.body.refresh_token,
        accessToken: r.body.access_token,
        expiresAt: now() + (r.body.expires_in ?? 3600) * 1000,
        obtainedAt: now(),
      };
      device = null;
      lastError = null;
      lastRefreshAt = now();
      await save();
      setHealth('ok');
      return { status: 'signed_in' };
    }
    if (r.body.error === 'authorization_pending' || r.body.error === 'slow_down') return { status: 'pending' };
    device = null;
    return { status: r.body.error === 'access_denied' ? 'denied' : 'expired' };
  }

  return { getAccessToken, check, health, startDeviceAuth, pollDeviceAuth };
}

import { join } from 'node:path';

/** Read settings from the environment. Secrets are never logged or returned by the API. */
export function loadConfig(env = process.env) {
  const int = (name, def) => {
    const n = Number(env[name]);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  const dataDir = env.PITUBE_DATA_DIR || './data';
  return {
    host: env.PITUBE_HOST || '127.0.0.1',
    port: int('PITUBE_PORT', 3200),
    /** Bearer token for the API; required unless PITUBE_MODE=development. */
    apiToken: env.PITUBE_API_TOKEN || '',
    mode: env.PITUBE_MODE || 'production',
    dataDir,
    tokenFile: env.PITUBE_TOKEN_FILE || join(dataDir, 'tokens.json'),
    clientId: env.YOUTUBE_CLIENT_ID || '',
    clientSecret: env.YOUTUBE_CLIENT_SECRET || '',
    /** Optional: a refresh token from the environment instead of the device sign-in. */
    refreshToken: env.YOUTUBE_REFRESH_TOKEN || '',
    /** Pin the monitor to one broadcast; empty = the active one, else the next upcoming. */
    broadcastId: env.PITUBE_BROADCAST_ID || '',
    /** Overrides the stream key read from the bound YouTube stream. */
    streamKey: env.PITUBE_STREAM_KEY || '',
    /** Poll speed. The YouTube quota is 10 000 units/day; one poll costs about 3. */
    pollActiveMs: int('PITUBE_POLL_ACTIVE_MS', 15_000),
    pollIdleMs: int('PITUBE_POLL_IDLE_MS', 300_000),
    /** Warn when the refresh token is this old (Google "testing" apps expire it after 7 days). */
    tokenWarnDays: int('PITUBE_TOKEN_WARN_DAYS', 5),
    /** Captions while the broadcast is not live: hold up to this many for this long, else drop. */
    captionHoldMax: int('PITUBE_CAPTION_HOLD_MAX', 50),
    captionHoldMs: int('PITUBE_CAPTION_HOLD_MS', 30_000),
    confirmTtlMs: int('PITUBE_CONFIRM_TTL_MS', 30_000),
  };
}

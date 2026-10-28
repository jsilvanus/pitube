/**
 * Configuration loader for pitube.
 */

export interface PitubeConfig {
  port: number;
  host: string;
  apiKey: string | null;

  gatewayUrl: string;
  gatewayToken: string | null;

  youtubeClientId: string | null;
  youtubeClientSecret: string | null;
  youtubeRefreshToken: string | null;
  youtubeStreamKey: string | null;

  /** Delay in milliseconds to align caption timestamps with live video delay (default: 30000) */
  youtubeDelayMs: number;

  /** Stale threshold in ms before transcripts are discarded (default: 90000) */
  staleCaptionMs: number;

  /** Base URL for YouTube live caption ingestion */
  captionBaseUrl: string;

  /** Heartbeat interval to report status to pigateway (default: 5000 ms) */
  statusIntervalMs: number;

  /** TTL in milliseconds announced to pigateway (default: 15000 ms) */
  statusTtlMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PitubeConfig {
  const port = parseInt(env.PITUBE_PORT || "3105", 10);
  const host = env.PITUBE_HOST || "0.0.0.0";
  const apiKey = env.PITUBE_API_KEY?.trim() || null;

  const gatewayUrl = (env.PITUBE_GATEWAY_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");
  const gatewayToken = env.PITUBE_GATEWAY_TOKEN?.trim() || null;

  const youtubeClientId = env.YOUTUBE_CLIENT_ID?.trim() || null;
  const youtubeClientSecret = env.YOUTUBE_CLIENT_SECRET?.trim() || null;
  const youtubeRefreshToken = env.YOUTUBE_REFRESH_TOKEN?.trim() || null;
  const youtubeStreamKey = env.YOUTUBE_STREAM_KEY?.trim() || null;

  const youtubeDelayMs = parseInt(env.PITUBE_DELAY_MS || "30000", 10);
  const staleCaptionMs = parseInt(env.PITUBE_STALE_CAPTION_MS || "90000", 10);
  const captionBaseUrl = env.PITUBE_CAPTION_BASE_URL || "http://upload.youtube.com/closedcaption";

  const statusIntervalMs = parseInt(env.PITUBE_STATUS_INTERVAL_MS || "5000", 10);
  const statusTtlMs = parseInt(env.PITUBE_STATUS_TTL_MS || "15000", 10);

  return {
    port,
    host,
    apiKey,
    gatewayUrl,
    gatewayToken,
    youtubeClientId,
    youtubeClientSecret,
    youtubeRefreshToken,
    youtubeStreamKey,
    youtubeDelayMs: Number.isFinite(youtubeDelayMs) && youtubeDelayMs >= 0 ? youtubeDelayMs : 30000,
    staleCaptionMs: Number.isFinite(staleCaptionMs) && staleCaptionMs > 0 ? staleCaptionMs : 90000,
    captionBaseUrl,
    statusIntervalMs: Number.isFinite(statusIntervalMs) && statusIntervalMs >= 1000 ? statusIntervalMs : 5000,
    statusTtlMs: Number.isFinite(statusTtlMs) && statusTtlMs >= 1000 ? statusTtlMs : 15000,
  };
}

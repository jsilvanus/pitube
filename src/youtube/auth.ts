/**
 * YouTube OAuth 2.0 access token manager.
 * Refreshes token before expiration and shares fresh tokens across callers.
 */

import type { TokenResponse } from "./types.js";

const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const INITIAL_RETRY_BACKOFF_MS = 30_000;
const MAX_RETRY_BACKOFF_MS = 15 * 60_000;

export type AuthState = "unchecked" | "ok" | "revoked" | "refresh_failed";

export interface AuthHealth {
  state: AuthState;
  lastRefreshAt: string | null;
  accessTokenExpiresAt: string | null;
  lastError: string | null;
}

export interface YouTubeAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUrl?: string;
}

export class YouTubeAuth {
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private refreshPromise: Promise<string> | null = null;
  private readonly tokenUrl: string;
  private state: AuthState = "unchecked";
  private lastRefreshAt: number | null = null;
  private lastError: string | null = null;
  private consecutiveFailures: number = 0;
  private nextRetryAt: number = 0;
  /** Called when the state changes (the event bus publishes auth.health). */
  onHealthChange?: (health: AuthHealth) => void;

  constructor(
    private readonly config: YouTubeAuthConfig,
    private readonly fetchFn: typeof fetch = globalThis.fetch,
    private readonly nowFn: () => number = Date.now
  ) {
    this.tokenUrl = config.tokenUrl || DEFAULT_TOKEN_URL;
  }

  /**
   * Returns a valid access token, refreshing if within 60 seconds of expiry.
   */
  async getAccessToken(force: boolean = false): Promise<string> {
    const now = this.nowFn();
    if (!force && this.accessToken && this.tokenExpiry > now + 60_000) {
      return this.accessToken;
    }

    if (!force && this.state === "revoked") {
      throw new Error(`YouTube OAuth refresh token is revoked (${this.lastError ?? "invalid_grant"}); re-authorization required`);
    }

    if (!force && this.nextRetryAt > now) {
      throw new Error(`YouTube OAuth token refresh backing off (${this.lastError ?? "refresh_failed"})`);
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refreshToken();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private recordFailure(errorMessage: string, revoked: boolean): void {
    this.lastError = errorMessage;
    this.consecutiveFailures += 1;
    if (revoked) {
      this.nextRetryAt = Number.POSITIVE_INFINITY;
      this.setState("revoked");
      return;
    }
    const backoff = Math.min(INITIAL_RETRY_BACKOFF_MS * 2 ** (this.consecutiveFailures - 1), MAX_RETRY_BACKOFF_MS);
    this.nextRetryAt = this.nowFn() + backoff;
    this.setState("refresh_failed");
  }

  private async refreshToken(): Promise<string> {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
      grant_type: "refresh_token",
    });

    let response: Response;
    try {
      response = await this.fetchFn(this.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordFailure(msg, false);
      throw err;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const revoked = /invalid_grant/.test(errorText);
      this.recordFailure(`HTTP ${response.status}`, revoked);
      throw new Error(`YouTube OAuth token refresh failed (${response.status}): ${errorText.slice(0, 300)}`);
    }

    const data = (await response.json()) as TokenResponse;
    if (!data.access_token) {
      this.recordFailure("Missing access_token in response", false);
      throw new Error("YouTube OAuth response did not contain access_token");
    }

    const now = this.nowFn();
    this.accessToken = data.access_token;
    this.lastRefreshAt = now;
    this.lastError = null;
    this.consecutiveFailures = 0;
    this.nextRetryAt = 0;
    this.setState("ok");
    const expiresInSec = typeof data.expires_in === "number" ? data.expires_in : 3600;
    this.tokenExpiry = now + expiresInSec * 1000;

    return this.accessToken;
  }

  private setState(next: AuthState): void {
    if (next !== this.state) {
      this.state = next;
      this.onHealthChange?.(this.health());
    }
  }

  /** Sign-in state without secrets. */
  health(): AuthHealth {
    return {
      state: this.state,
      lastRefreshAt: this.lastRefreshAt ? new Date(this.lastRefreshAt).toISOString() : null,
      accessTokenExpiresAt: this.tokenExpiry ? new Date(this.tokenExpiry).toISOString() : null,
      lastError: this.lastError,
    };
  }

  /** Force a refresh now so a dead sign-in shows up before Sunday, not during it. */
  async check(): Promise<AuthHealth> {
    this.invalidate();
    try {
      await this.getAccessToken(true);
    } catch {
      // recorded in health
    }
    return this.health();
  }

  /** Clear cached token (e.g. if an API call returned 401 Unauthorized) */
  invalidate(): void {
    this.accessToken = null;
    this.tokenExpiry = 0;
  }
}

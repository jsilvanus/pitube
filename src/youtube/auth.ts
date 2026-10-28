/**
 * YouTube OAuth 2.0 access token manager.
 * Refreshes token before expiration and shares fresh tokens across callers.
 */

import type { TokenResponse } from "./types.js";

const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";

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

  constructor(
    private readonly config: YouTubeAuthConfig,
    private readonly fetchFn: typeof fetch = globalThis.fetch
  ) {
    this.tokenUrl = config.tokenUrl || DEFAULT_TOKEN_URL;
  }

  /**
   * Returns a valid access token, refreshing if within 60 seconds of expiry.
   */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && this.tokenExpiry > now + 60_000) {
      return this.accessToken;
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

  private async refreshToken(): Promise<string> {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
      grant_type: "refresh_token",
    });

    const response = await this.fetchFn(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`YouTube OAuth token refresh failed (${response.status}): ${errorText.slice(0, 300)}`);
    }

    const data = (await response.json()) as TokenResponse;
    if (!data.access_token) {
      throw new Error("YouTube OAuth response did not contain access_token");
    }

    this.accessToken = data.access_token;
    const expiresInSec = typeof data.expires_in === "number" ? data.expires_in : 3600;
    this.tokenExpiry = Date.now() + expiresInSec * 1000;

    return this.accessToken;
  }

  /** Clear cached token (e.g. if an API call returned 401 Unauthorized) */
  invalidate(): void {
    this.accessToken = null;
    this.tokenExpiry = 0;
  }
}

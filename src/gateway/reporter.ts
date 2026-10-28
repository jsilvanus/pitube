/**
 * Periodic status reporter that pushes pitube's YouTube live state to pigateway (PUT /api/v1/youtube/status).
 */

import type { GatewayYoutubeStatusPayload } from "../types.js";

export interface GatewayStatusReporterOptions {
  gatewayUrl: string;
  gatewayToken?: string | null;
  intervalMs?: number;
  ttlMs?: number;
  getStatus: () => { state: "live" | "offline" | "unknown"; detail?: string };
  fetchFn?: typeof fetch;
}

export class GatewayStatusReporter {
  private readonly gatewayUrl: string;
  private readonly gatewayToken?: string | null;
  private readonly intervalMs: number;
  private readonly ttlMs: number;
  private readonly getStatus: () => { state: "live" | "offline" | "unknown"; detail?: string };
  private readonly fetchFn: typeof fetch;

  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(options: GatewayStatusReporterOptions) {
    this.gatewayUrl = options.gatewayUrl.replace(/\/+$/, "");
    this.gatewayToken = options.gatewayToken;
    this.intervalMs = options.intervalMs ?? 5000;
    this.ttlMs = options.ttlMs ?? 15000;
    this.getStatus = options.getStatus;
    this.fetchFn = options.fetchFn || globalThis.fetch;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.sendUpdate().catch(() => {});
    this.timer = setInterval(() => {
      this.sendUpdate().catch(() => {});
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
  }

  async sendUpdate(): Promise<boolean> {
    const current = this.getStatus();
    const payload: GatewayYoutubeStatusPayload = {
      state: current.state,
      detail: current.detail,
      checkedAt: Date.now(),
      ttlMs: this.ttlMs,
    };

    const url = `${this.gatewayUrl}/api/v1/youtube/status`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.gatewayToken) {
      headers["Authorization"] = `Bearer ${this.gatewayToken}`;
    }

    try {
      const response = await this.fetchFn(url, {
        method: "PUT",
        headers,
        body: JSON.stringify(payload),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

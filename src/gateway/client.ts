/**
 * SSE client connecting to pigateway's event bus (/api/v1/events).
 */

import type { GatewayTranscriptEvent } from "../types.js";

export interface GatewaySSEClientOptions {
  gatewayUrl: string;
  gatewayToken?: string | null;
  onTranscript?: (event: GatewayTranscriptEvent) => void;
  onActivity?: (state: string) => void;
  onConnectionChange?: (connected: boolean, epoch: string | null) => void;
  fetchFn?: typeof fetch;
}

export class GatewaySSEClient {
  private readonly gatewayUrl: string;
  private readonly gatewayToken?: string | null;
  private readonly fetchFn: typeof fetch;

  private onTranscript?: (event: GatewayTranscriptEvent) => void;
  private onActivity?: (state: string) => void;
  private onConnectionChange?: (connected: boolean, epoch: string | null) => void;

  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  private currentEpoch: string | null = null;
  private lastSeq: number = -1;
  private isConnected = false;
  private isStopped = false;
  private lastEventAt: number | null = null;

  constructor(options: GatewaySSEClientOptions) {
    this.gatewayUrl = options.gatewayUrl.replace(/\/+$/, "");
    this.gatewayToken = options.gatewayToken;
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.onTranscript = options.onTranscript;
    this.onActivity = options.onActivity;
    this.onConnectionChange = options.onConnectionChange;
  }

  start(): void {
    this.isStopped = false;
    this.connect();
  }

  stop(): void {
    this.isStopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.setConnected(false, null);
  }

  getStatus() {
    return {
      connected: this.isConnected,
      lastEventAt: this.lastEventAt,
      epoch: this.currentEpoch,
    };
  }

  private connect(): void {
    if (this.isStopped) return;

    this.abortController = new AbortController();
    const url = `${this.gatewayUrl}/api/v1/events?types=transcript,pivoice-activity`;
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
    };

    if (this.gatewayToken) {
      headers["Authorization"] = `Bearer ${this.gatewayToken}`;
    }

    if (this.currentEpoch && this.lastSeq >= 0) {
      headers["Last-Event-ID"] = `${this.currentEpoch}:${this.lastSeq}`;
    }

    this.resetSilenceTimer();

    this.fetchFn(url, {
      headers,
      signal: this.abortController.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Gateway returned HTTP ${response.status}`);
        }
        if (!response.body) {
          throw new Error("No response body for SSE");
        }

        this.setConnected(true, this.currentEpoch);
        this.resetSilenceTimer();

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          this.resetSilenceTimer();
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          let currentEvent = "";
          let currentId = "";
          let currentData = "";

          for (const line of lines) {
            const trimmed = line.trimEnd();
            if (trimmed.startsWith(":")) {
              // Comment / keep-alive ping
              this.resetSilenceTimer();
              continue;
            }

            if (!trimmed) {
              // Empty line = dispatch event
              if (currentEvent || currentData) {
                this.dispatch(currentEvent, currentData, currentId);
              }
              currentEvent = "";
              currentId = "";
              currentData = "";
              continue;
            }

            if (trimmed.startsWith("event:")) {
              currentEvent = trimmed.slice(6).trim();
            } else if (trimmed.startsWith("id:")) {
              currentId = trimmed.slice(3).trim();
            } else if (trimmed.startsWith("data:")) {
              const dataVal = trimmed.slice(5).trim();
              currentData = currentData ? `${currentData}\n${dataVal}` : dataVal;
            }
          }
        }
      })
      .catch(() => {
        // Connection error or aborted
      })
      .finally(() => {
        this.setConnected(false, this.currentEpoch);
        this.scheduleReconnect();
      });
  }

  private dispatch(event: string, dataStr: string, id: string): void {
    this.lastEventAt = Date.now();
    this.resetSilenceTimer();

    if (id && id.includes(":")) {
      const [epoch, seqStr] = id.split(":");
      const seq = parseInt(seqStr || "-1", 10);
      if (epoch) {
        if (epoch !== this.currentEpoch) {
          this.currentEpoch = epoch;
          this.lastSeq = -1;
        }
        if (Number.isFinite(seq)) {
          this.lastSeq = seq;
        }
      }
    }

    try {
      const data = dataStr ? JSON.parse(dataStr) : null;
      if (event === "transcript" && data) {
        this.onTranscript?.(data as GatewayTranscriptEvent);
      } else if (event === "pivoice-activity" && data?.state) {
        this.onActivity?.(String(data.state));
      } else if (event === "ready" && data) {
        this.setConnected(true, this.currentEpoch);
      }
    } catch {
      // Ignore unparseable data
    }
  }

  private resetSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    // CONTRACT: 45 s of silence indicates dead connection
    this.silenceTimer = setTimeout(() => {
      if (this.abortController) {
        this.abortController.abort();
      }
    }, 45_000);
    this.silenceTimer.unref?.();
  }

  private setConnected(connected: boolean, epoch: string | null): void {
    if (this.isConnected !== connected) {
      this.isConnected = connected;
      this.onConnectionChange?.(connected, epoch);
    }
  }

  private scheduleReconnect(): void {
    if (this.isStopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, 2000);
    this.reconnectTimer.unref?.();
  }
}

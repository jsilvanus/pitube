/**
 * Pushes the YouTube RTMP target to piencoder (PUT /api/v1/encoder/:unit/rtmp/:channel).
 * The stream key goes only from pitube to piencoder on the local network; it is never returned by pitube.
 */

export interface EncoderClientOptions {
  baseUrl: string;
  token?: string | null;
  unit?: number;
  channel?: 1 | 2;
  fetchFn?: typeof fetch;
}

export class EncoderClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  readonly unit: number;
  readonly channel: 1 | 2;
  private readonly fetchFn: typeof fetch;

  constructor(options: EncoderClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token ?? null;
    this.unit = options.unit ?? 1;
    this.channel = options.channel ?? 1;
    this.fetchFn = options.fetchFn || globalThis.fetch;
  }

  async setRtmp(url: string, streamName: string, target?: { unit?: number; channel?: 1 | 2 }): Promise<void> {
    const unit = target?.unit ?? this.unit;
    const channel = target?.channel ?? this.channel;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    const response = await this.fetchFn(`${this.baseUrl}/api/v1/encoder/${unit}/rtmp/${channel}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ url, streamName }),
    });
    if (!response.ok) {
      // Do not echo the response body: it could repeat the key.
      throw new Error(`piencoder refused the RTMP target [${response.status}]`);
    }
  }
}

/**
 * In-process event bus. The SSE route (GET /api/v1/events) and other modules subscribe here.
 * Types: status, broadcast.status, broadcast.transition, stream.health, stream.status, auth.health.
 */

import { EventEmitter } from "node:events";

export interface PitubeEvent {
  type: string;
  data: Record<string, unknown>;
  at: string;
}

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  publish(type: string, data: Record<string, unknown> = {}): void {
    const event: PitubeEvent = { type, data, at: new Date().toISOString() };
    this.emitter.emit("event", event);
  }

  subscribe(fn: (event: PitubeEvent) => void): () => void {
    this.emitter.on("event", fn);
    return () => this.emitter.off("event", fn);
  }
}

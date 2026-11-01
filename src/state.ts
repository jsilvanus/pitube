/**
 * Small crash-safe state file. It remembers the active broadcast and the caption sequence number so a
 * restart during a service continues the sequence instead of starting at 0 (YouTube ignores or
 * rejects captions whose sequence goes backwards). It never holds the stream key.
 */

import fs from "node:fs";
import path from "node:path";

export interface PersistedState {
  broadcastId: string | null;
  /** Next caption sequence number to use for broadcastId. */
  sequence: number;
  updatedAt: number;
}

export class StateStore {
  constructor(private readonly file: string | null) {}

  load(): PersistedState | null {
    if (!this.file) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<PersistedState>;
      if (typeof raw.sequence !== "number" || !Number.isFinite(raw.sequence) || raw.sequence < 0) return null;
      return {
        broadcastId: typeof raw.broadcastId === "string" ? raw.broadcastId : null,
        sequence: Math.floor(raw.sequence),
        updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
      };
    } catch {
      return null;
    }
  }

  save(state: Omit<PersistedState, "updatedAt">, now: number = Date.now()): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(path.resolve(this.file)), { recursive: true });
      const temp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(temp, JSON.stringify({ ...state, updatedAt: now }), { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch {
      // A state write failure must never stop captions.
    }
  }

  clear(): void {
    if (!this.file) return;
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      // ignore
    }
  }
}

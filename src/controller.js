import { randomUUID } from 'node:crypto';

export class GuardError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Broadcast transitions with guards. Going live needs an active stream;
 * ending needs a second, confirming call with a short-lived code.
 */
export function createController({ youtube, monitor, events, config, now = () => Date.now() }) {
  const pendingEnd = new Map(); // broadcastId -> { token, expiresAt }

  async function load(id) {
    const broadcast = await youtube.getBroadcast(id);
    if (!broadcast) throw new GuardError(404, 'not_found', `Broadcast ${id} not found`);
    const stream = broadcast.boundStreamId ? await youtube.getStream(broadcast.boundStreamId) : null;
    return { broadcast, stream };
  }

  function requireActiveStream(stream) {
    if (!stream) throw new GuardError(409, 'no_stream', 'The broadcast has no stream bound to it');
    if (stream.streamStatus !== 'active') {
      throw new GuardError(409, 'stream_not_active', `The stream is ${stream.streamStatus}; start the encoder first`);
    }
  }

  async function apply(id, status) {
    const broadcast = await youtube.transition(id, status);
    events.publish('broadcast.transition', { id, to: status });
    await monitor.refresh().catch(() => {});
    return broadcast;
  }

  return {
    async startTesting(id) {
      const { broadcast, stream } = await load(id);
      if (broadcast.lifeCycleStatus === 'testing') return { broadcast, changed: false };
      if (broadcast.lifeCycleStatus !== 'ready') {
        throw new GuardError(409, 'wrong_state', `Cannot test a broadcast that is ${broadcast.lifeCycleStatus}`);
      }
      requireActiveStream(stream);
      return { broadcast: await apply(id, 'testing'), changed: true };
    },

    async goLive(id, { force = false } = {}) {
      const { broadcast, stream } = await load(id);
      if (broadcast.lifeCycleStatus === 'live') return { broadcast, changed: false };
      if (!['ready', 'testing'].includes(broadcast.lifeCycleStatus)) {
        throw new GuardError(409, 'wrong_state', `Cannot go live from ${broadcast.lifeCycleStatus}`);
      }
      requireActiveStream(stream);
      if (!force && (stream.health === 'bad' || stream.health === 'noData')) {
        throw new GuardError(409, 'stream_unhealthy', `Stream health is ${stream.health}; fix it or pass force`);
      }
      return { broadcast: await apply(id, 'live'), changed: true };
    },

    /** Step 1 of ending: returns a code to send back to confirmEnd. Changes nothing. */
    async requestEnd(id) {
      const { broadcast } = await load(id);
      if (broadcast.lifeCycleStatus !== 'live' && broadcast.lifeCycleStatus !== 'testing') {
        throw new GuardError(409, 'wrong_state', `Cannot end a broadcast that is ${broadcast.lifeCycleStatus}`);
      }
      const token = randomUUID();
      pendingEnd.set(id, { token, expiresAt: now() + config.confirmTtlMs });
      return { confirmToken: token, expiresInMs: config.confirmTtlMs, title: broadcast.title, lifeCycleStatus: broadcast.lifeCycleStatus };
    },

    async confirmEnd(id, token) {
      const p = pendingEnd.get(id);
      pendingEnd.delete(id);
      if (!p || p.token !== token || p.expiresAt < now()) {
        throw new GuardError(409, 'confirm_invalid', 'Confirmation is missing or expired; request the end again');
      }
      const { broadcast } = await load(id);
      if (broadcast.lifeCycleStatus === 'complete') return { broadcast, changed: false };
      return { broadcast: await apply(id, 'complete'), changed: true };
    },
  };
}

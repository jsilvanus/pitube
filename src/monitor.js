/** Polls the broadcast and its stream, publishes changes as events. Read-only. */
export function createMonitor({ config, youtube, events, now = () => Date.now() }) {
  let state = emptyState();
  let timer = null;
  let running = false;
  let polling = null;

  function emptyState() {
    return { level: 'unknown', live: false, broadcast: null, stream: null, viewers: null, error: null, updatedAt: null };
  }

  function levelOf(b, s) {
    if (!b) return 'idle';
    switch (b.lifeCycleStatus) {
      case 'live':
        return s && (s.health === 'bad' || s.health === 'noData') ? 'unhealthy' : 'live';
      case 'testing': return 'testing';
      case 'complete':
      case 'revoked': return 'ended';
      default: return 'upcoming';
    }
  }

  async function pick() {
    if (config.broadcastId) return youtube.getBroadcast(config.broadcastId);
    const active = await youtube.listBroadcasts('active');
    if (active[0]) return active[0];
    const upcoming = await youtube.listBroadcasts('upcoming');
    upcoming.sort((a, b) => String(a.scheduledStart).localeCompare(String(b.scheduledStart)));
    return upcoming[0] ?? null;
  }

  async function doPoll() {
    const before = state;
    try {
      const broadcast = await pick();
      const stream = broadcast?.boundStreamId ? await youtube.getStream(broadcast.boundStreamId) : null;
      const viewers = broadcast?.lifeCycleStatus === 'live' ? await youtube.getViewers(broadcast.id) : null;
      const level = levelOf(broadcast, stream);
      state = {
        level, live: broadcast?.lifeCycleStatus === 'live', broadcast, stream, viewers,
        error: null, updatedAt: new Date(now()).toISOString(),
      };
      if (before.broadcast?.id !== broadcast?.id || before.broadcast?.lifeCycleStatus !== broadcast?.lifeCycleStatus) {
        events.publish('broadcast.status', { id: broadcast?.id ?? null, lifeCycleStatus: broadcast?.lifeCycleStatus ?? null });
      }
      if (before.stream?.health !== stream?.health) events.publish('stream.health', { health: stream?.health ?? null });
      if (before.stream?.streamStatus !== stream?.streamStatus) events.publish('stream.status', { streamStatus: stream?.streamStatus ?? null });
      if (before.level !== level) events.publish('status', { level, live: state.live });
    } catch (err) {
      const error = { code: err.code || err.reason || 'poll_failed', message: err.message };
      state = { ...before, error, updatedAt: new Date(now()).toISOString() };
      if (before.error?.code !== error.code) events.publish('monitor.error', error);
    }
    events.publish('poll', { level: state.level });
    return state;
  }

  /** One poll at a time; callers share the in-flight one. */
  function refresh() {
    polling ??= doPoll().finally(() => { polling = null; });
    return polling;
  }

  function schedule() {
    if (!running) return;
    const fast = state.level === 'live' || state.level === 'unhealthy' || state.level === 'testing';
    timer = setTimeout(async () => {
      await refresh();
      schedule();
    }, fast ? config.pollActiveMs : config.pollIdleMs);
    timer.unref?.();
  }

  return {
    refresh,
    start() {
      running = true;
      refresh().finally(schedule);
    },
    stop() { running = false; clearTimeout(timer); },
    /** Snapshot for the API; the stream key is never included. */
    snapshot() {
      const { stream, ...rest } = state;
      if (!stream) return { ...rest, stream: null };
      const { streamName: _key, ...publicStream } = stream;
      return { ...rest, stream: publicStream };
    },
    current: () => state,
  };
}

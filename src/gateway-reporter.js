/**
 * Pushes the YouTube live status to pigateway (PUT /api/v1/youtube/status) after every
 * monitor poll, so pilight and others read it from the gateway. Each report carries a
 * ttl of three poll intervals: if pitube stops, the gateway turns the state to "unknown".
 */
export function stateFor(snapshot) {
  if (snapshot.error) return { state: 'unknown', detail: `monitor error: ${snapshot.error.code}` };
  if (snapshot.level === 'live') return { state: 'live', detail: snapshot.broadcast?.title };
  if (snapshot.level === 'unhealthy') return { state: 'live', detail: `stream health ${snapshot.stream?.health}` };
  if (snapshot.level === 'unknown') return { state: 'unknown', detail: 'not polled yet' };
  return { state: 'offline', detail: snapshot.level };
}

export function createGatewayReporter({ config, monitor, events, fetch = globalThis.fetch, now = () => Date.now(), log = () => {} }) {
  let last = null;

  async function report() {
    const snap = monitor.snapshot();
    const fast = ['live', 'unhealthy', 'testing'].includes(snap.level);
    const ttlMs = Math.min(3_600_000, Math.max(1000, 3 * (fast ? config.pollActiveMs : config.pollIdleMs)));
    const { state, detail } = stateFor(snap);
    const body = { state, checkedAt: now(), ttlMs, ...(detail ? { detail: String(detail).slice(0, 500) } : {}) };
    try {
      const res = await fetch(`${config.gatewayUrl.replace(/\/$/, '')}/api/v1/youtube/status`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(config.gatewayApiKey ? { authorization: `Bearer ${config.gatewayApiKey}`, 'x-api-key': config.gatewayApiKey } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      last = { at: new Date(now()).toISOString(), ok: res.ok, status: res.status, state };
      if (!res.ok) log(`gateway refused the YouTube status: HTTP ${res.status}`);
    } catch (err) {
      last = { at: new Date(now()).toISOString(), ok: false, error: err.message, state };
      log(`gateway unreachable: ${err.message}`);
    }
    return last;
  }

  const unsubscribe = events.subscribe((e) => { if (e.type === 'poll') report(); });
  return { report, stop: unsubscribe, status: () => ({ configured: true, last }) };
}

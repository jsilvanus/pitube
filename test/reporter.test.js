import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayReporter, stateFor } from '../src/gateway-reporter.js';
import { createMonitor } from '../src/monitor.js';
import { setup } from './helpers.js';

test('state mapping', () => {
  assert.equal(stateFor({ level: 'live', broadcast: { title: 'Messu' } }).state, 'live');
  assert.equal(stateFor({ level: 'unhealthy', stream: { health: 'bad' } }).state, 'live');
  assert.equal(stateFor({ level: 'testing' }).state, 'offline');
  assert.equal(stateFor({ level: 'idle', error: { code: 'x' } }).state, 'unknown');
});

test('every poll is pushed to the gateway with a ttl of three intervals', async () => {
  const s = setup({ gatewayUrl: 'http://gw:3100/', gatewayApiKey: 'k' }, { broadcast: { id: 'b1', lifeCycleStatus: 'live', title: 'Messu', boundStreamId: 's1' } });
  const monitor = createMonitor({ config: s.config, youtube: s.youtube, events: s.events });
  const calls = [];
  createGatewayReporter({
    config: s.config, monitor, events: s.events, now: () => 5000,
    fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; },
  });
  await monitor.refresh();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://gw:3100/api/v1/youtube/status');
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.headers['x-api-key'], 'k');
  assert.deepEqual(JSON.parse(calls[0].init.body), { state: 'live', checkedAt: 5000, ttlMs: 45000, detail: 'Messu' });
});

test('an unreachable gateway never breaks the monitor', async () => {
  const s = setup({ gatewayUrl: 'http://gw' });
  const monitor = createMonitor({ config: s.config, youtube: s.youtube, events: s.events });
  const logs = [];
  createGatewayReporter({
    config: s.config, monitor, events: s.events, log: (m) => logs.push(m),
    fetch: async () => { throw new Error('ECONNREFUSED'); },
  });
  await monitor.refresh();
  await new Promise((r) => setImmediate(r));
  assert.equal(monitor.current().level, 'upcoming');
  assert.equal(logs.length, 1);
});

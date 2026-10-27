import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createMonitor } from '../src/monitor.js';
import { createController } from '../src/controller.js';
import { createCaptionGateway } from '../src/captions.js';
import { setup } from './helpers.js';

function make(over, ytInit) {
  const s = setup(over, ytInit);
  const monitor = createMonitor({ config: s.config, youtube: s.youtube, events: s.events });
  const controller = createController({ youtube: s.youtube, monitor, events: s.events, config: s.config });
  const sent = [];
  const captions = createCaptionGateway({
    config: s.config, monitor, events: s.events,
    senderFactory: (key) => ({ start() { return this; }, async sendBatch(items) { sent.push({ key, items }); } }),
  });
  const tokens = { health: async () => ({ signedIn: true, state: 'ok' }), getAccessToken: async () => 'x', check: async () => ({}) };
  const app = buildApp(s.config, { ...s, monitor, controller, captions, tokens });
  const auth = { authorization: 'Bearer t' };
  return { ...s, app, monitor, sent, auth };
}

test('API needs the bearer token; health is open', async () => {
  const { app } = make();
  assert.equal((await app.inject('/health')).statusCode, 200);
  assert.equal((await app.inject('/api/v1/status')).statusCode, 401);
});

test('status never contains the stream key', async () => {
  const { app, auth } = make();
  await app.inject({ method: 'POST', url: '/api/v1/status/refresh', headers: auth });
  const res = await app.inject({ url: '/api/v1/status', headers: auth });
  assert.equal(res.json().level, 'upcoming');
  assert.ok(!res.body.includes('KEY-123'));
});

test('go-live is refused while the stream is not active', async () => {
  const { app, auth, youtube } = make({}, { stream: { id: 's1', streamStatus: 'inactive', health: 'noData' } });
  const res = await app.inject({ method: 'POST', url: '/api/v1/broadcasts/b1/go-live', headers: auth });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'stream_not_active');
  assert.ok(!youtube.state.calls.some((c) => c[0] === 'transition'));
});

test('go-live refuses bad health unless forced', async () => {
  const { app, auth } = make({}, { stream: { id: 's1', streamStatus: 'active', health: 'bad' } });
  const url = '/api/v1/broadcasts/b1/go-live';
  assert.equal((await app.inject({ method: 'POST', url, headers: auth })).json().error.code, 'stream_unhealthy');
  const forced = await app.inject({ method: 'POST', url, headers: { ...auth, 'content-type': 'application/json' }, payload: { force: true } });
  assert.equal(forced.statusCode, 200);
});

test('ending needs the confirm code, once', async () => {
  const { app, auth, youtube } = make({}, { broadcast: { id: 'b1', lifeCycleStatus: 'live', boundStreamId: 's1' } });
  const bad = await app.inject({ method: 'POST', url: '/api/v1/broadcasts/b1/end/confirm', headers: auth, payload: { confirmToken: 'nope' } });
  assert.equal(bad.statusCode, 409);
  const { confirmToken } = (await app.inject({ method: 'POST', url: '/api/v1/broadcasts/b1/end/request', headers: auth })).json();
  assert.equal(youtube.state.broadcast.lifeCycleStatus, 'live');
  const done = await app.inject({ method: 'POST', url: '/api/v1/broadcasts/b1/end/confirm', headers: auth, payload: { confirmToken } });
  assert.equal(done.statusCode, 200);
  assert.equal(youtube.state.broadcast.lifeCycleStatus, 'complete');
  const again = await app.inject({ method: 'POST', url: '/api/v1/broadcasts/b1/end/confirm', headers: auth, payload: { confirmToken } });
  assert.equal(again.statusCode, 409);
});

test('monitor publishes events on change and marks unhealthy streams', async () => {
  const { monitor, seen, youtube } = make({}, { broadcast: { id: 'b1', lifeCycleStatus: 'live', boundStreamId: 's1' } });
  await monitor.refresh();
  assert.equal(monitor.current().level, 'live');
  assert.equal(monitor.current().viewers, 7);
  youtube.state.stream = { ...youtube.state.stream, health: 'bad' };
  await monitor.refresh();
  assert.equal(monitor.current().level, 'unhealthy');
  assert.ok(seen.some((e) => e.type === 'stream.health' && e.data.health === 'bad'));
});

test('captions are held before live, flushed when live, rejected with no broadcast', async () => {
  const { app, auth, monitor, sent, youtube } = make();
  await monitor.refresh();
  const post = (text) => app.inject({ method: 'POST', url: '/api/v1/captions', headers: auth, payload: { captions: [{ text }] } });
  const held = await post('hei');
  assert.equal(held.statusCode, 202);
  assert.equal(sent.length, 0);
  youtube.state.broadcast = { ...youtube.state.broadcast, lifeCycleStatus: 'live' };
  await monitor.refresh();
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].key, 'KEY-123');
  assert.equal((await post('moi')).statusCode, 200);
  assert.equal(sent.length, 2);
  youtube.state.broadcast = null;
  await monitor.refresh();
  assert.equal((await post('x')).json().error.code, 'not_live');
});

test('every route is in the OpenAPI document', async () => {
  const { readFileSync } = await import('node:fs');
  const spec = JSON.parse(readFileSync(new URL('../openapi/openapi.json', import.meta.url), 'utf8'));
  const { app } = make();
  await app.ready();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item)) {
      if (path === '/api/v1/events') continue; // SSE never ends
      const url = path.replace(/\{id\}/g, 'x');
      const res = await app.inject({ method: method.toUpperCase(), url, headers: { authorization: 'Bearer t' } });
      assert.notEqual(res.statusCode, 404, `${method} ${path} not implemented`);
    }
  }
});

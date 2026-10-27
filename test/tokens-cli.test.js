import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTokenService } from '../src/auth/tokens.js';
import { createEventBus } from '../src/events.js';
import { buildRequest, operations } from '../bin/pitube.js';
import { config } from './helpers.js';

function fakeGoogle(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), body: String(init.body) });
    const r = responses.shift();
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  return { fetch, calls };
}

test('device sign-in stores tokens 0600 and health hides them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pitube-'));
  const cfg = config({ tokenFile: join(dir, 't.json'), clientId: 'id', clientSecret: 'sec' });
  const g = fakeGoogle([
    { status: 200, body: { device_code: 'dc', user_code: 'ABCD', verification_url: 'https://google.com/device', expires_in: 600, interval: 5 } },
    { status: 428, body: { error: 'authorization_pending' } },
    { status: 200, body: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 } },
  ]);
  const svc = createTokenService({ config: cfg, events: createEventBus(), fetch: g.fetch });
  assert.equal((await svc.startDeviceAuth()).userCode, 'ABCD');
  assert.equal((await svc.pollDeviceAuth()).status, 'pending');
  assert.equal((await svc.pollDeviceAuth()).status, 'signed_in');
  assert.equal(((await stat(cfg.tokenFile)).mode & 0o777), 0o600);
  assert.equal(JSON.parse(await readFile(cfg.tokenFile, 'utf8')).refreshToken, 'RT');
  const h = await svc.health();
  assert.equal(h.signedIn, true);
  assert.ok(!JSON.stringify(h).includes('RT'));
  assert.equal(await svc.getAccessToken(), 'AT');
});

test('a revoked refresh token is reported and published', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pitube-'));
  const cfg = config({ tokenFile: join(dir, 't.json'), refreshToken: 'RT' });
  const events = createEventBus();
  const seen = [];
  events.subscribe((e) => seen.push(e));
  const g = fakeGoogle([{ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }]);
  const svc = createTokenService({ config: cfg, events, fetch: g.fetch });
  const h = await svc.check();
  assert.equal(h.state, 'revoked');
  assert.ok(seen.some((e) => e.type === 'auth.health' && e.data.state === 'revoked'));
});

test('old sign-ins get a warning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pitube-'));
  const tokenFile = join(dir, 't.json');
  await writeFile(tokenFile, JSON.stringify({ refreshToken: 'RT', accessToken: null, expiresAt: 0, obtainedAt: 0 }));
  const svc = createTokenService({ config: config({ tokenFile }), events: createEventBus(), now: () => 6 * 86_400_000 });
  const h = await svc.health();
  assert.equal(h.signedInAgeDays, 6);
  assert.equal(h.warnings.length, 1);
});

test('CLI builds requests from the OpenAPI document', () => {
  const op = operations().find((o) => o.operationId === 'broadcasts-update');
  const r = buildRequest(op, ['b1', '--title', 'Uusi'], { PITUBE_API_TOKEN: 'tok' });
  assert.equal(r.url, 'http://127.0.0.1:3200/api/v1/broadcasts/b1');
  assert.equal(r.init.method, 'PATCH');
  assert.equal(r.init.headers.authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(r.init.body), { title: 'Uusi' });
  const live = operations().find((o) => o.operationId === 'broadcasts-go-live');
  assert.deepEqual(JSON.parse(buildRequest(live, ['b1', '--force'], {}).init.body), { force: true });
  assert.throws(() => buildRequest(op, [], {}), /usage/);
});

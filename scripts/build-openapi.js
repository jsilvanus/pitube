// Writes openapi/openapi.json from the table below. Run: node scripts/build-openapi.js
import { writeFileSync } from 'node:fs';

const bc = { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, lifeCycleStatus: { type: 'string' } } };
const fields = {
  title: { type: 'string' }, description: { type: 'string' },
  scheduledStart: { type: 'string', format: 'date-time' }, privacy: { enum: ['public', 'unlisted', 'private'] },
};
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const body = (schema, required = true) => ({ required, content: { 'application/json': { schema } } });
const ok = (description = 'OK') => ({ 200: { description } });

// [method, path, operationId, summary, extras]
const ops = [
  ['get', '/health', 'health', 'Liveness', { open: true }],
  ['get', '/ready', 'ready', 'Ready when YouTube is signed in', { open: true }],
  ['get', '/api/v1/status', 'status', 'Current broadcast, stream health and viewers (level: idle|upcoming|testing|live|unhealthy|ended)', {}],
  ['post', '/api/v1/status/refresh', 'status-refresh', 'Poll YouTube now', {}],
  ['get', '/api/v1/events', 'events', 'Server-Sent Events: status, broadcast.status, stream.health, stream.status, auth.health, monitor.error, broadcast.transition', { sse: true }],
  ['get', '/api/v1/auth/health', 'auth-health', 'Sign-in and refresh-token health (no secrets)', {}],
  ['post', '/api/v1/auth/check', 'auth-check', 'Refresh the token now and report health', {}],
  ['post', '/api/v1/auth/device/start', 'auth-device-start', 'Start the device sign-in; returns a URL and a code', {}],
  ['post', '/api/v1/auth/device/poll', 'auth-device-poll', 'Poll the device sign-in (pending|signed_in|denied|expired)', {}],
  ['get', '/api/v1/broadcasts', 'broadcasts-list', 'List broadcasts', { query: [{ name: 'status', in: 'query', schema: { enum: ['active', 'upcoming', 'completed', 'all'] } }] }],
  ['post', '/api/v1/broadcasts', 'broadcasts-create', 'Create a broadcast, optionally bound to a stream', {
    body: body({ type: 'object', required: ['title', 'scheduledStart'], properties: { ...fields, streamId: { type: 'string' } } }), status: 201 }],
  ['patch', '/api/v1/broadcasts/{id}', 'broadcasts-update', 'Change title, description, start or privacy', {
    params: [idParam], body: body({ type: 'object', properties: fields }) }],
  ['post', '/api/v1/broadcasts/{id}/bind', 'broadcasts-bind', 'Bind a broadcast to a stream', {
    params: [idParam], body: body({ type: 'object', required: ['streamId'], properties: { streamId: { type: 'string' } } }) }],
  ['post', '/api/v1/broadcasts/{id}/testing', 'broadcasts-testing', 'Move ready to testing (needs an active stream)', { params: [idParam] }],
  ['post', '/api/v1/broadcasts/{id}/go-live', 'broadcasts-go-live', 'Go live. Refused unless the stream is active and not unhealthy (force overrides health only)', {
    params: [idParam], body: body({ type: 'object', properties: { force: { type: 'boolean' } } }, false) }],
  ['post', '/api/v1/broadcasts/{id}/end/request', 'broadcasts-end-request', 'Ending step 1: returns a short-lived confirmToken, changes nothing', { params: [idParam] }],
  ['post', '/api/v1/broadcasts/{id}/end/confirm', 'broadcasts-end-confirm', 'Ending step 2: complete the broadcast with the confirmToken', {
    params: [idParam], body: body({ type: 'object', required: ['confirmToken'], properties: { confirmToken: { type: 'string' } } }) }],
  ['get', '/api/v1/streams', 'streams-list', 'List your streams (no stream keys)', {}],
  ['post', '/api/v1/streams', 'streams-create', 'Create a reusable stream (fixed stream key)', {
    body: body({ type: 'object', required: ['title'], properties: { title: { type: 'string' } } }), status: 201 }],
  ['get', '/api/v1/streams/{id}/ingest', 'streams-ingest', 'Ingest address and stream key, for configuring the encoder (secret)', { params: [idParam] }],
  ['post', '/api/v1/captions', 'captions-send', 'Send captions; held (202) while the broadcast exists but is not live, 409 when there is none', {
    body: body({ type: 'object', required: ['captions'], properties: { captions: { type: 'array', items: {
      type: 'object', required: ['text'], properties: { text: { type: 'string' }, timestamp: { type: 'string' } } } } } }) }],
  ['get', '/api/v1/captions/status', 'captions-status', 'Caption gateway counters', {}],
];

const paths = {};
for (const [method, path, operationId, summary, x] of ops) {
  const parameters = [...(x.params ?? []), ...(x.query ?? [])];
  paths[path] ??= {};
  paths[path][method] = {
    operationId, summary,
    ...(x.open ? { security: [] } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(x.body ? { requestBody: x.body } : {}),
    responses: { [x.status ?? 200]: { description: 'OK', ...(x.sse ? { content: { 'text/event-stream': {} } } : {}) },
      default: { description: 'Error {error:{code,message}}' } },
  };
}

const doc = {
  openapi: '3.0.3',
  info: { title: 'pitube', version: '0.1.0', description: 'The Pi\'s only YouTube connection. Never touches video.' },
  servers: [{ url: 'http://127.0.0.1:3200' }],
  security: [{ bearer: [] }],
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, schemas: { Broadcast: bc } },
  paths,
};
writeFileSync(new URL('../openapi/openapi.json', import.meta.url), JSON.stringify(doc, null, 2) + '\n');

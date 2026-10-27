import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { createEventBus } from './events.js';
import { createTokenService } from './auth/tokens.js';
import { createYouTubeClient, YouTubeApiError } from './youtube/api.js';
import { createMonitor } from './monitor.js';
import { createController, GuardError } from './controller.js';
import { createCaptionGateway, CaptionError } from './captions.js';

const err = (code, message) => ({ error: { code, message } });

function sameToken(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Build the API. Every collaborator can be injected, which the tests rely on. */
export function buildApp(config, deps = {}) {
  const app = Fastify({ logger: deps.logger ?? false });
  const events = deps.events ?? createEventBus();
  const tokens = deps.tokens ?? createTokenService({ config, events });
  const youtube = deps.youtube ?? createYouTubeClient({ getAccessToken: tokens.getAccessToken });
  const monitor = deps.monitor ?? createMonitor({ config, youtube, events });
  const controller = deps.controller ?? createController({ youtube, monitor, events, config });
  const captions = deps.captions ?? createCaptionGateway({ config, monitor, events });

  app.setErrorHandler((e, _req, reply) => {
    if (e instanceof GuardError || e instanceof CaptionError) return reply.code(e.status).send(err(e.code, e.message));
    if (e instanceof YouTubeApiError) {
      const status = e.status === 403 && e.reason === 'quotaExceeded' ? 429 : e.status === 404 ? 404 : 502;
      return reply.code(status).send(err(e.reason || 'youtube_error', e.message));
    }
    if (e.code === 'auth_missing' || e.code === 'auth_revoked' || e.code === 'auth_refresh_failed') {
      return reply.code(401).send(err(e.code, e.message));
    }
    if (e.validation || e.statusCode === 400) return reply.code(400).send(err('bad_request', e.message));
    reply.log.error(e);
    return reply.code(500).send(err('internal', 'Internal error'));
  });

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (!config.apiToken) {
      if (config.mode === 'development') return;
      return reply.code(503).send(err('no_api_token', 'PITUBE_API_TOKEN is not set'));
    }
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ') || !sameToken(header.slice(7), config.apiToken)) {
      return reply.code(401).send(err('unauthorized', 'Missing or wrong bearer token'));
    }
  });

  app.get('/health', async () => ({ ok: true }));
  app.get('/ready', async () => {
    const h = await tokens.health();
    return { ok: h.signedIn, auth: h.state };
  });

  app.get('/api/v1/status', async () => monitor.snapshot());
  app.post('/api/v1/status/refresh', async () => {
    await monitor.refresh();
    return monitor.snapshot();
  });

  app.get('/api/v1/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: status\ndata: ${JSON.stringify(monitor.snapshot())}\n\n`);
    const unsubscribe = events.subscribe((e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify({ ...e.data, at: e.at })}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => { clearInterval(ping); unsubscribe(); });
  });

  // Sign-in and token health
  app.get('/api/v1/auth/health', async () => tokens.health());
  app.post('/api/v1/auth/check', async () => tokens.check());
  app.post('/api/v1/auth/device/start', async () => tokens.startDeviceAuth());
  app.post('/api/v1/auth/device/poll', async () => tokens.pollDeviceAuth());

  // Broadcasts and streams (config)
  app.get('/api/v1/broadcasts', async (req) => {
    const status = ['active', 'upcoming', 'completed', 'all'].includes(req.query.status) ? req.query.status : 'all';
    return { broadcasts: await youtube.listBroadcasts(status) };
  });

  app.post('/api/v1/broadcasts', {
    schema: {
      body: {
        type: 'object',
        required: ['title', 'scheduledStart'],
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 100 },
          description: { type: 'string', maxLength: 5000 },
          scheduledStart: { type: 'string', format: 'date-time' },
          privacy: { enum: ['public', 'unlisted', 'private'] },
          streamId: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { streamId, ...fields } = req.body;
    let broadcast = await youtube.createBroadcast(fields);
    if (streamId) broadcast = await youtube.bind(broadcast.id, streamId);
    return reply.code(201).send(broadcast);
  });

  app.patch('/api/v1/broadcasts/:id', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 100 },
          description: { type: 'string', maxLength: 5000 },
          scheduledStart: { type: 'string', format: 'date-time' },
          privacy: { enum: ['public', 'unlisted', 'private'] },
        },
      },
    },
  }, async (req) => {
    const current = await youtube.getBroadcast(req.params.id);
    if (!current) throw new GuardError(404, 'not_found', `Broadcast ${req.params.id} not found`);
    return youtube.updateBroadcast(current, req.body);
  });

  app.post('/api/v1/broadcasts/:id/bind', {
    schema: { body: { type: 'object', required: ['streamId'], properties: { streamId: { type: 'string' } } } },
  }, async (req) => youtube.bind(req.params.id, req.body.streamId));

  app.post('/api/v1/broadcasts/:id/testing', async (req) => controller.startTesting(req.params.id));
  app.post('/api/v1/broadcasts/:id/go-live', {
    schema: { body: { type: ['object', 'null'], properties: { force: { type: 'boolean' } } } },
  }, async (req) => controller.goLive(req.params.id, { force: req.body?.force === true }));
  app.post('/api/v1/broadcasts/:id/end/request', async (req) => controller.requestEnd(req.params.id));
  app.post('/api/v1/broadcasts/:id/end/confirm', {
    schema: { body: { type: 'object', required: ['confirmToken'], properties: { confirmToken: { type: 'string' } } } },
  }, async (req) => controller.confirmEnd(req.params.id, req.body.confirmToken));

  app.get('/api/v1/streams', async () => {
    const streams = await youtube.listStreams();
    return { streams: streams.map(({ streamName: _k, ...s }) => s) };
  });
  app.post('/api/v1/streams', {
    schema: { body: { type: 'object', required: ['title'], additionalProperties: false, properties: { title: { type: 'string', minLength: 1 } } } },
  }, async (req, reply) => {
    const { streamName: _k, ...stream } = await youtube.createStream(req.body);
    return reply.code(201).send(stream);
  });
  /** The only place the stream key leaves pitube: for configuring the encoder. */
  app.get('/api/v1/streams/:id/ingest', async (req) => {
    const s = await youtube.getStream(req.params.id);
    if (!s) throw new GuardError(404, 'not_found', `Stream ${req.params.id} not found`);
    return { address: s.ingestionAddress, streamKey: s.streamName };
  });

  // Caption gateway
  app.post('/api/v1/captions', {
    schema: {
      body: {
        type: 'object',
        required: ['captions'],
        additionalProperties: false,
        properties: {
          captions: {
            type: 'array', minItems: 1, maxItems: 100,
            items: {
              type: 'object', required: ['text'], additionalProperties: false,
              properties: { text: { type: 'string', minLength: 1, maxLength: 1000 }, timestamp: { type: 'string' } },
            },
          },
        },
      },
    },
  }, async (req, reply) => {
    const result = await captions.send(req.body.captions);
    return reply.code(result.delivered ? 200 : 202).send(result);
  });
  app.get('/api/v1/captions/status', async () => captions.status());

  app.addHook('onClose', async () => monitor.stop());
  app.decorate('pitube', { events, tokens, youtube, monitor, controller, captions });
  return app;
}

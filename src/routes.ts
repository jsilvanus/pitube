/**
 * HTTP routes for pitube control and status API.
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { LifecycleCoordinator } from "./lifecycle/coordinator.js";
import type { GatewaySSEClient } from "./gateway/client.js";
import type { AdHocBroadcastInput } from "./types.js";

export interface PitubeRoutesOptions {
  coordinator: LifecycleCoordinator;
  gatewayClient: GatewaySSEClient;
  apiKey?: string | null;
}

const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerRoutes(
  app: FastifyInstance,
  options: PitubeRoutesOptions
): void {
  const { coordinator, gatewayClient, apiKey } = options;

  // Raw image bodies for the thumbnail route
  app.addContentTypeParser(["image/jpeg", "image/png", "image/gif"], { parseAs: "buffer", bodyLimit: THUMBNAIL_MAX_BYTES + 1024 }, (_req, body, done) => {
    done(null, body);
  });

  // Optional simple API key authentication for writes
  if (apiKey) {
    app.addHook("onRequest", async (request, reply) => {
      if (request.method === "GET" || request.url === "/health") {
        return; // open reads and health
      }
      const authHeader = request.headers.authorization;
      const xApiKey = request.headers["x-api-key"];
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : xApiKey;

      if (!token || token !== apiKey) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
    });
  }

  // Health
  app.get("/health", async () => {
    return { ok: true, service: "pitube" };
  });

  // Overall pitube status
  app.get("/api/v1/status", async () => {
    const gwStatus = gatewayClient.getStatus();
    return coordinator.getStatus(gwStatus.connected, gwStatus.lastEventAt, gwStatus.epoch);
  });

  // List upcoming broadcasts
  app.get<{ Querystring: { status?: string } }>("/api/v1/broadcasts", async (request, reply) => {
    const status = request.query.status ?? "upcoming";
    if (status !== "upcoming" && status !== "active" && status !== "completed" && status !== "all") {
      return reply.code(400).send({ error: "status must be upcoming, active, completed or all" });
    }
    const items = await coordinator.listUpcomingBroadcasts(status);
    return {
      selectedId: coordinator.getSelectedBroadcast()?.id ?? null,
      items,
    };
  });

  // Channel liveStreams (ingests). Never includes the stream key or ingestion address.
  app.get("/api/v1/streams", async (_request, reply) => {
    try {
      return { items: await coordinator.listStreams() };
    } catch (err: unknown) {
      return reply.code(502).send({ error: errorMessage(err) });
    }
  });

  app.post<{ Body: { title?: string } }>("/api/v1/streams/create", async (request, reply) => {
    const title = request.body?.title?.trim() || "pitube";
    try {
      return reply.code(201).send(await coordinator.createStream(title));
    } catch (err: unknown) {
      return reply.code(502).send({ error: errorMessage(err) });
    }
  });

  // Push the selected broadcast's RTMP target to piencoder (the key goes only to piencoder).
  app.post<{ Body: { unit?: number; channel?: number } | undefined }>(
    "/api/v1/ingest/apply",
    async (request, reply) => {
      const channel = request.body?.channel;
      if (channel !== undefined && channel !== 1 && channel !== 2) {
        return reply.code(400).send({ error: "channel must be 1 or 2" });
      }
      const unit = request.body?.unit;
      if (unit !== undefined && (!Number.isInteger(unit) || unit < 1)) {
        return reply.code(400).send({ error: "unit must be a positive integer" });
      }
      try {
        const target = {
          ...(unit !== undefined ? { unit } : {}),
          ...(channel !== undefined ? { channel: channel as 1 | 2 } : {}),
        };
        return reply.code(200).send({ ok: true, ...(await coordinator.applyIngestToEncoder(target)) });
      } catch (err: unknown) {
        return reply.code(400).send({ error: errorMessage(err) });
      }
    }
  );

  // Change privacy of the selected (or given) broadcast: public, unlisted, private
  app.post<{ Body: { privacy?: string; broadcastId?: string } }>(
    "/api/v1/broadcasts/privacy",
    async (request, reply) => {
      const privacy = request.body?.privacy;
      if (privacy !== "public" && privacy !== "unlisted" && privacy !== "private") {
        return reply.code(400).send({ error: "privacy must be public, unlisted or private" });
      }
      try {
        return reply.code(200).send(await coordinator.setPrivacy(privacy, request.body?.broadcastId?.trim() || undefined));
      } catch (err: unknown) {
        return reply.code(400).send({ error: errorMessage(err) });
      }
    }
  );

  // Watch and embed URLs of the selected (or given) broadcast
  app.get<{ Querystring: { broadcastId?: string } }>("/api/v1/broadcasts/url", async (request, reply) => {
    try {
      return reply.code(200).send(await coordinator.getUrls(request.query.broadcastId?.trim() || undefined));
    } catch (err: unknown) {
      return reply.code(400).send({ error: errorMessage(err) });
    }
  });

  // Upload a thumbnail: raw image body (image/jpeg, image/png, image/gif, max 2 MB)
  app.post<{ Querystring: { broadcastId?: string } }>(
    "/api/v1/broadcasts/thumbnail",
    async (request, reply) => {
      const contentType = String(request.headers["content-type"] ?? "").split(";")[0]!.trim();
      const body = request.body;
      if (!["image/jpeg", "image/png", "image/gif"].includes(contentType) || !(body instanceof Uint8Array)) {
        return reply.code(400).send({ error: "send the image as the raw body with Content-Type image/jpeg, image/png or image/gif" });
      }
      if (body.length === 0 || body.length > THUMBNAIL_MAX_BYTES) {
        return reply.code(400).send({ error: `thumbnail must be 1 byte to ${THUMBNAIL_MAX_BYTES} bytes` });
      }
      try {
        const result = await coordinator.setThumbnail(body, contentType, request.query.broadcastId?.trim() || undefined);
        return reply.code(200).send({ ok: true, ...result });
      } catch (err: unknown) {
        return reply.code(400).send({ error: errorMessage(err) });
      }
    }
  );

  // Select a broadcast by ID or "auto"
  app.post<{ Body: { broadcastId?: string } }>(
    "/api/v1/broadcasts/select",
    async (request, reply) => {
      const id = request.body?.broadcastId?.trim();
      if (!id) {
        return reply.code(400).send({ error: "broadcastId is required" });
      }
      try {
        const selected = await coordinator.selectBroadcast(id);
        return reply.code(200).send(selected);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: msg });
      }
    }
  );

  // Create an ad-hoc broadcast
  app.post<{ Body: AdHocBroadcastInput }>(
    "/api/v1/broadcasts/create",
    async (request, reply) => {
      const { title, privacy, description, scheduledStartTime } = request.body || {};
      if (!title || typeof title !== "string" || !title.trim()) {
        return reply.code(400).send({ error: "title is required" });
      }

      try {
        const created = await coordinator.createAdHocBroadcast({
          title: title.trim(),
          privacy,
          description,
          scheduledStartTime,
        });
        return reply.code(201).send(created);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: msg });
      }
    }
  );

  // Transition selected broadcast to live (body {"to":"testing"} stops at testing for a preview check)
  app.post<{ Body: { to?: string } | undefined }>("/api/v1/broadcasts/start", async (request, reply) => {
    const to = request.body?.to;
    if (to !== undefined && to !== "testing" && to !== "live") {
      return reply.code(400).send({ error: "to must be testing or live" });
    }
    try {
      const result = await coordinator.startBroadcast(to ?? "live");
      return reply.code(200).send(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }
  });

  // Transition selected broadcast to complete
  app.post("/api/v1/broadcasts/stop", async (_request, reply) => {
    try {
      const result = await coordinator.stopBroadcast();
      return reply.code(200).send(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }
  });

  // Current active broadcast details and preview URL
  app.get("/api/v1/broadcasts/current", async (_request, reply) => {
    const current = coordinator.getSelectedBroadcast();
    if (!current) {
      return reply.code(200).send({
        broadcast: null,
        state: coordinator.getState(),
        streamHealth: coordinator.getStreamHealth(),
        captions: coordinator.getCaptionsStats(),
      });
    }

    return reply.code(200).send({
      broadcast: current,
      state: coordinator.getState(),
      streamHealth: coordinator.getStreamHealth(),
      captions: coordinator.getCaptionsStats(),
    });
  });
}

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

export function registerRoutes(
  app: FastifyInstance,
  options: PitubeRoutesOptions
): void {
  const { coordinator, gatewayClient, apiKey } = options;

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
  app.get("/api/v1/broadcasts", async () => {
    const items = await coordinator.listUpcomingBroadcasts();
    return {
      selectedId: coordinator.getSelectedBroadcast()?.id ?? null,
      items,
    };
  });

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

  // Transition selected broadcast to live
  app.post("/api/v1/broadcasts/start", async (_request, reply) => {
    try {
      const result = await coordinator.startBroadcast();
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

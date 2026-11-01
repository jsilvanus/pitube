// Writes openapi/openapi.json from the table below. Run: pnpm run openapi
// tests/openapi.test.ts checks that every operation here is a registered route.
import { writeFileSync } from "node:fs";

const idParam = { name: "id", in: "path", required: true, schema: { type: "string" } };
const body = (schema, required = true) => ({ required, content: { "application/json": { schema } } });
const privacy = { enum: ["public", "unlisted", "private"] };
const optionalBroadcastId = { name: "broadcastId", in: "query", schema: { type: "string" } };

// [method, path, operationId, summary, extras]
const ops = [
  ["get", "/health", "health", "Liveness", { open: true }],
  ["get", "/api/v1/status", "status", "State, level (idle|upcoming|testing|live|unhealthy|ended), selected broadcast, stream health, caption counters", {}],
  ["get", "/api/v1/events", "events", "Server-Sent Events: status, broadcast.status, broadcast.transition, stream.health, auth.health", { sse: true }],
  ["get", "/api/v1/auth/health", "auth-health", "Sign-in state without secrets (unchecked|ok|revoked|refresh_failed)", {}],
  ["post", "/api/v1/auth/check", "auth-check", "Refresh the token now and report health", {}],
  ["get", "/api/v1/broadcasts", "broadcasts-list", "List broadcasts", { query: [{ name: "status", in: "query", schema: { enum: ["upcoming", "active", "completed", "all"] } }] }],
  ["get", "/api/v1/broadcasts/current", "broadcasts-current", "Selected broadcast, stream health and caption counters", {}],
  ["post", "/api/v1/broadcasts/select", "broadcasts-select", "Select a broadcast by id, or auto (within 60 minutes of now)", {
    body: body({ type: "object", required: ["broadcastId"], properties: { broadcastId: { type: "string" } } }) }],
  ["post", "/api/v1/broadcasts/create", "broadcasts-create", "Create a broadcast (default unlisted) and select it", {
    status: 201,
    body: body({ type: "object", required: ["title"], properties: {
      title: { type: "string" }, description: { type: "string" }, privacy, scheduledStartTime: { type: "string", format: "date-time" }, autoSelect: { type: "boolean" } } }) }],
  ["patch", "/api/v1/broadcasts/{id}", "broadcasts-update", "Change title, description, scheduled start or privacy", {
    params: [idParam],
    body: body({ type: "object", properties: { title: { type: "string" }, description: { type: "string" }, scheduledStartTime: { type: "string", format: "date-time" }, privacy } }) }],
  ["post", "/api/v1/broadcasts/privacy", "broadcasts-privacy", "Change privacy of the selected (or given) broadcast", {
    body: body({ type: "object", required: ["privacy"], properties: { privacy, broadcastId: { type: "string" } } }) }],
  ["get", "/api/v1/broadcasts/url", "broadcasts-url", "Watch and embed URLs, privacy and status", { query: [optionalBroadcastId] }],
  ["post", "/api/v1/broadcasts/thumbnail", "broadcasts-thumbnail", "Upload a thumbnail (raw image body, max 2 MB). CLI: --file <path>", {
    query: [optionalBroadcastId],
    body: { required: true, content: { "image/jpeg": {}, "image/png": {}, "image/gif": {} } } }],
  ["post", "/api/v1/broadcasts/start", "broadcasts-start", "Refused until the stream receives data. ready -> testing -> live; to=testing stops at testing", {
    body: body({ type: "object", properties: { to: { enum: ["testing", "live"] } } }, false) }],
  ["post", "/api/v1/broadcasts/stop/request", "broadcasts-stop-request", "Ending step 1: returns a short-lived confirmToken, changes nothing", {}],
  ["post", "/api/v1/broadcasts/stop", "broadcasts-stop", "Ending step 2: complete the broadcast (confirmToken required when PITUBE_REQUIRE_STOP_CONFIRM=1)", {
    body: body({ type: "object", properties: { confirmToken: { type: "string" } } }, false) }],
  ["get", "/api/v1/streams", "streams-list", "List streams with status and health (never the key)", {}],
  ["post", "/api/v1/streams/create", "streams-create", "Create a reusable RTMP stream", {
    status: 201, body: body({ type: "object", properties: { title: { type: "string" } } }, false) }],
  ["post", "/api/v1/ingest/apply", "ingest-apply", "Push the selected broadcast's RTMP target to piencoder (needs PITUBE_ENCODER_URL)", {
    body: body({ type: "object", properties: { unit: { type: "integer" }, channel: { type: "integer", enum: [1, 2] } } }, false) }],
];

const paths = {};
for (const [method, path, operationId, summary, x] of ops) {
  const parameters = [...(x.params ?? []), ...(x.query ?? [])];
  paths[path] ??= {};
  paths[path][method] = {
    operationId,
    summary,
    ...(x.open ? { security: [] } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(x.body ? { requestBody: x.body } : {}),
    responses: {
      [x.status ?? 200]: { description: "OK", ...(x.sse ? { content: { "text/event-stream": {} } } : {}) },
      default: { description: "Error {error: string}" },
    },
  };
}

const doc = {
  openapi: "3.0.3",
  info: { title: "pitube", version: "0.1.0", description: "The Pi's only YouTube connection: broadcasts, streams, lifecycle and live captions. Never touches video." },
  servers: [{ url: "http://127.0.0.1:3500" }],
  security: [{ bearer: [] }],
  components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
  paths,
};
writeFileSync(new URL("../openapi/openapi.json", import.meta.url), JSON.stringify(doc, null, 2) + "\n");

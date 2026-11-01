#!/usr/bin/env node
/**
 * pitube CLI.
 *   pitube auth youtube          steps and URL for the one-time YouTube consent
 *   pitube help                  list the commands
 *   pitube <operation> [path params] [--key value] [--json '{...}'] [--file image]
 * Operations are generated from openapi/openapi.json at run time (one command per operationId).
 * Env: PITUBE_URL (default http://127.0.0.1:<PITUBE_PORT or 3105>), PITUBE_API_KEY.
 */

import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";

interface Param { name: string; in: string }
export interface Operation {
  method: string;
  path: string;
  operationId: string;
  summary?: string;
  parameters?: Param[];
  requestBody?: { content?: Record<string, { schema?: { properties?: Record<string, { type?: string }> } }> };
  responses?: Record<string, { content?: Record<string, unknown> }>;
}

export function loadOperations(file = new URL("../openapi/openapi.json", import.meta.url)): Operation[] {
  const spec = JSON.parse(readFileSync(file, "utf8")) as { paths: Record<string, Record<string, Omit<Operation, "method" | "path">>> };
  const out: Operation[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) out.push({ method, path, ...op });
  }
  return out;
}

export function buildRequest(op: Operation, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const pathParams = (op.parameters ?? []).filter((p) => p.in === "path");
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  let rawJson: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") rawJson = args[++i] ?? null;
    else if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = true;
      else { flags[a.slice(2)] = next; i++; }
    } else positional.push(a);
  }
  if (positional.length < pathParams.length) {
    throw new Error(`usage: pitube ${op.operationId} ${pathParams.map((p) => `<${p.name}>`).join(" ")} [--json '{...}']`);
  }
  let path = op.path;
  pathParams.forEach((p, i) => { path = path.replace(`{${p.name}}`, encodeURIComponent(positional[i]!)); });

  const query = new URLSearchParams();
  for (const p of (op.parameters ?? []).filter((q) => q.in === "query")) {
    const v = flags[p.name];
    if (v !== undefined) { query.set(p.name, String(v)); delete flags[p.name]; }
  }

  const headers: Record<string, string> = {};
  if (env.PITUBE_API_KEY) headers["Authorization"] = `Bearer ${env.PITUBE_API_KEY}`;

  const content = op.requestBody?.content ?? {};
  let body: string | Buffer | undefined;
  const imageType = Object.keys(content).find((t) => t.startsWith("image/"));
  if (imageType) {
    const file = flags["file"];
    if (typeof file !== "string") throw new Error(`usage: pitube ${op.operationId} --file <image>`);
    delete flags["file"];
    body = readFileSync(file);
    headers["Content-Type"] = /\.png$/i.test(file) ? "image/png" : /\.gif$/i.test(file) ? "image/gif" : "image/jpeg";
  } else if (op.requestBody) {
    const props = content["application/json"]?.schema?.properties ?? {};
    let obj: Record<string, unknown> = {};
    if (rawJson) obj = JSON.parse(rawJson) as Record<string, unknown>;
    else {
      for (const [k, v] of Object.entries(flags)) {
        const type = props[k]?.type;
        obj[k] = type === "boolean" ? v === true || v === "true" : type === "integer" ? Number(v) : v;
      }
    }
    body = JSON.stringify(obj);
    headers["Content-Type"] = "application/json";
  }

  const port = env.PITUBE_PORT || "3105";
  const base = (env.PITUBE_URL || `http://127.0.0.1:${port}`).replace(/\/$/, "");
  const qs = query.toString();
  return {
    url: `${base}${path}${qs ? `?${qs}` : ""}`,
    init: { method: op.method.toUpperCase(), headers, ...(body ? { body: body as unknown as RequestInit["body"] } : {}) } as RequestInit,
  };
}

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;

  if (name === "auth" && rest[0] === "youtube") {
    const config = loadConfig();
    const base = `http://localhost:${config.port}`;
    const missing = [
      !config.youtubeClientId && "YOUTUBE_CLIENT_ID",
      !config.youtubeClientSecret && "YOUTUBE_CLIENT_SECRET",
    ].filter(Boolean);
    console.log("YouTube consent (one time, gives YOUTUBE_REFRESH_TOKEN)\n");
    if (missing.length > 0) console.log(`Set ${missing.join(" and ")} in pitube's environment first, then restart pitube.\n`);
    console.log(`1. In Google Cloud (APIs & Services > Credentials > your OAuth client) add this authorised redirect URI:\n   ${config.oauthRedirectUri}`);
    console.log(`2. On your own computer open a tunnel to the Pi (pitube must be running there):\n   ssh -L ${config.port}:localhost:${config.port} pi@kirkonpi.local`);
    console.log(`3. Open this URL in the browser on that computer and approve:\n   ${base}/auth/youtube`);
    console.log(`4. The token is saved to ${config.envFile} (mode 600), never printed. Restart pitube afterwards.`);
    return missing.length > 0 ? 1 : 0;
  }

  const ops = loadOperations();
  if (!name || name === "help" || name === "--help") {
    console.log("pitube <command>\n");
    console.log(`  ${"auth youtube".padEnd(24)} One-time YouTube consent steps`);
    for (const op of ops) console.log(`  ${op.operationId.padEnd(24)} ${op.summary ?? ""}`);
    return 0;
  }
  const op = ops.find((o) => o.operationId === name);
  if (!op) { console.error(`unknown command: ${name} (try: pitube help)`); return 2; }

  const { url, init } = buildRequest(op, rest);
  const res = await fetch(url, init);
  if (op.responses?.["200"]?.content?.["text/event-stream"] && res.body) {
    const decoder = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) process.stdout.write(decoder.decode(chunk));
    return 0;
  }
  const text = await res.text();
  try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }
  return res.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); }
  );
}

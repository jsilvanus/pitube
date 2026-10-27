#!/usr/bin/env node
// CLI generated from openapi/openapi.json: one command per operationId.
//   pitube <operation> [path params...] [--key value ...] [--json '{...}']
// Env: PITUBE_URL (default http://127.0.0.1:3200), PITUBE_API_TOKEN.
import { readFileSync } from 'node:fs';

const spec = JSON.parse(readFileSync(new URL('../openapi/openapi.json', import.meta.url), 'utf8'));

export function operations(doc = spec) {
  const out = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) out.push({ method, path, ...op });
  }
  return out;
}

export function buildRequest(op, args, env = process.env) {
  const params = (op.parameters ?? []).filter((p) => p.in === 'path');
  const positional = [];
  const flags = {};
  let rawJson = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') rawJson = args[++i];
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  if (positional.length < params.length) {
    throw new Error(`usage: pitube ${op.operationId} ${params.map((p) => `<${p.name}>`).join(' ')} [--json '{...}']`);
  }
  let path = op.path;
  params.forEach((p, i) => { path = path.replace(`{${p.name}}`, encodeURIComponent(positional[i])); });
  const query = new URLSearchParams();
  for (const p of (op.parameters ?? []).filter((q) => q.in === 'query')) {
    if (flags[p.name] !== undefined) { query.set(p.name, flags[p.name]); delete flags[p.name]; }
  }
  const schemaProps = op.requestBody?.content?.['application/json']?.schema?.properties ?? {};
  let body;
  if (rawJson) body = JSON.parse(rawJson);
  else if (op.requestBody) {
    body = {};
    for (const [k, v] of Object.entries(flags)) {
      const type = schemaProps[k]?.type;
      body[k] = type === 'boolean' ? v === true || v === 'true' : v;
    }
  }
  const base = (env.PITUBE_URL || 'http://127.0.0.1:3200').replace(/\/$/, '');
  const qs = query.toString();
  return {
    url: `${base}${path}${qs ? `?${qs}` : ''}`,
    init: {
      method: op.method.toUpperCase(),
      headers: {
        ...(env.PITUBE_API_TOKEN ? { authorization: `Bearer ${env.PITUBE_API_TOKEN}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    },
  };
}

async function main(argv) {
  const [name, ...rest] = argv;
  const ops = operations();
  if (!name || name === '--help' || name === 'help') {
    console.log('pitube <command>\n');
    for (const op of ops) console.log(`  ${op.operationId.padEnd(24)} ${op.summary}`);
    return 0;
  }
  const op = ops.find((o) => o.operationId === name);
  if (!op) { console.error(`unknown command: ${name} (try: pitube help)`); return 2; }
  const { url, init } = buildRequest(op, rest);
  const res = await fetch(url, init);
  if (op.responses?.['200']?.content?.['text/event-stream']) {
    const decoder = new TextDecoder();
    for await (const chunk of res.body) process.stdout.write(decoder.decode(chunk));
    return 0;
  }
  const text = await res.text();
  try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }
  return res.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
}

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { buildRequest, loadOperations } from "../src/cli.js";

describe("OpenAPI and CLI", () => {
  const ops = loadOperations();

  it("every documented operation is a registered route", () => {
    const app = buildApp(loadConfig({ PITUBE_STATE_FILE: "" }));
    for (const op of ops) {
      const url = op.path.replace(/\{(\w+)\}/g, ":$1");
      assert.ok(
        app.server.hasRoute({ method: op.method.toUpperCase() as "GET", url }),
        `${op.method.toUpperCase()} ${op.path} is documented but not registered`
      );
    }
  });

  it("operation ids are unique", () => {
    const ids = ops.map((o) => o.operationId);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("builds a PATCH with a path parameter and JSON body from flags", () => {
    const op = ops.find((o) => o.operationId === "broadcasts-update")!;
    const { url, init } = buildRequest(op, ["bc 1", "--title", "Messu"], { PITUBE_API_KEY: "k" });
    assert.equal(url, "http://127.0.0.1:3105/api/v1/broadcasts/bc%201");
    assert.equal(init.method, "PATCH");
    assert.equal(init.body, '{"title":"Messu"}');
    assert.equal((init.headers as Record<string, string>)["Authorization"], "Bearer k");
  });

  it("builds query parameters and typed body values", () => {
    const list = ops.find((o) => o.operationId === "broadcasts-list")!;
    assert.equal(buildRequest(list, ["--status", "active"], {}).url, "http://127.0.0.1:3105/api/v1/broadcasts?status=active");
    const apply = ops.find((o) => o.operationId === "ingest-apply")!;
    assert.equal(buildRequest(apply, ["--unit", "2", "--channel", "2"], {}).init.body, '{"unit":2,"channel":2}');
  });

  it("requires path parameters", () => {
    const op = ops.find((o) => o.operationId === "broadcasts-update")!;
    assert.throws(() => buildRequest(op, [], {}), /usage/);
  });
});

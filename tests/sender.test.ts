import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LiveCaptionSender } from "../src/captions/sender.js";

describe("LiveCaptionSender", () => {
  it("redacts stream key from error messages and text", () => {
    const sender = new LiveCaptionSender({
      streamKey: "secret-key-999888",
    });

    const error = "Failed to POST to http://upload.youtube.com/closedcaption?cid=secret-key-999888&seq=4";
    const redacted = sender.redact(error);

    assert.ok(!redacted.includes("secret-key-999888"));
    assert.match(redacted, /\[REDACTED/);
  });

  it("tracks dropped count when sending before start", async () => {
    const sender = new LiveCaptionSender({
      streamKey: "dummy_key",
    });

    assert.equal(sender.running, false);
    const sent = await sender.send("Test", Date.now());
    assert.equal(sent, false);
    assert.equal(sender.getStats().dropped, 1);
  });
});

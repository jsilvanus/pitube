import { YoutubeLiveCaptionSender } from 'lcyt';

export class CaptionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * The caption gateway: other services (pivoice) post text here, pitube adds
 * YouTube's sequence numbers and timestamps (via lcyt) and delivers it.
 * While a broadcast exists but is not live, captions are held for a short time.
 */
export function createCaptionGateway({
  config, monitor, events, now = () => Date.now(),
  senderFactory = (streamKey) => new YoutubeLiveCaptionSender({ streamKey }),
}) {
  let held = [];
  let sender = null;
  let senderKey = null;
  const stats = { sent: 0, dropped: 0, lastSentAt: null, lastError: null };

  function streamKey() {
    return config.streamKey || monitor.current().stream?.streamName || null;
  }

  function getSender(key) {
    if (!sender || senderKey !== key) {
      sender = senderFactory(key).start();
      senderKey = key;
    }
    return sender;
  }

  function prune() {
    const cutoff = now() - config.captionHoldMs;
    const fresh = held.filter((c) => c.heldAt >= cutoff);
    stats.dropped += held.length - fresh.length;
    held = fresh;
  }

  async function deliver(items) {
    const key = streamKey();
    if (!key) throw new CaptionError(409, 'no_stream_key', 'No stream key known yet; the broadcast has no bound stream');
    try {
      await getSender(key).sendBatch(items.map(({ text, timestamp }) => (timestamp ? { text, timestamp } : { text })));
    } catch (err) {
      stats.lastError = err.message;
      throw new CaptionError(502, 'youtube_rejected', `YouTube rejected the captions: ${err.message}`);
    }
    stats.sent += items.length;
    stats.lastSentAt = new Date(now()).toISOString();
    stats.lastError = null;
  }

  async function flush() {
    prune();
    if (!held.length) return 0;
    const batch = held;
    held = [];
    await deliver(batch);
    return batch.length;
  }

  events.subscribe((e) => {
    if (e.type === 'status' && e.data.live) flush().catch(() => {});
  });

  return {
    async send(items) {
      const cur = monitor.current();
      if (cur.live) {
        if (held.length) await flush();
        await deliver(items);
        return { delivered: items.length, held: 0 };
      }
      if (cur.level === 'upcoming' || cur.level === 'testing') {
        const room = Math.max(0, config.captionHoldMax - held.length);
        held.push(...items.slice(0, room).map((c) => ({ ...c, heldAt: now() })));
        stats.dropped += Math.max(0, items.length - room);
        return { delivered: 0, held: Math.min(items.length, room) };
      }
      throw new CaptionError(409, 'not_live', `No broadcast to caption (monitor level: ${cur.level})`);
    },
    status: () => ({ held: held.length, streamKeyKnown: Boolean(streamKey()), ...stats }),
    flush,
  };
}

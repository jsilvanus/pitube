const BASE = 'https://www.googleapis.com/youtube/v3';

export class YouTubeApiError extends Error {
  constructor(status, body) {
    const reason = body?.error?.errors?.[0]?.reason;
    super(body?.error?.message || `YouTube API error ${status}`);
    this.name = 'YouTubeApiError';
    this.status = status;
    this.reason = reason ?? null;
  }
}

export function toBroadcast(item) {
  if (!item) return null;
  return {
    id: item.id,
    title: item.snippet?.title ?? '',
    description: item.snippet?.description ?? '',
    scheduledStart: item.snippet?.scheduledStartTime ?? null,
    actualStart: item.snippet?.actualStartTime ?? null,
    lifeCycleStatus: item.status?.lifeCycleStatus ?? 'unknown',
    privacy: item.status?.privacyStatus ?? null,
    boundStreamId: item.contentDetails?.boundStreamId ?? null,
    enableAutoStart: item.contentDetails?.enableAutoStart ?? null,
    enableAutoStop: item.contentDetails?.enableAutoStop ?? null,
  };
}

export function toStream(item) {
  if (!item) return null;
  return {
    id: item.id,
    title: item.snippet?.title ?? '',
    streamStatus: item.status?.streamStatus ?? 'unknown',
    health: item.status?.healthStatus?.status ?? 'noData',
    issues: (item.status?.healthStatus?.configurationIssues ?? []).map((i) => ({
      type: i.type, severity: i.severity, reason: i.reason, description: i.description,
    })),
    reusable: item.cdn?.isReusable ?? false,
    ingestionType: item.cdn?.ingestionType ?? null,
    ingestionAddress: item.cdn?.ingestionInfo?.ingestionAddress ?? null,
    /** The stream key; also the `cid` of the caption endpoint. Treat as secret. */
    streamName: item.cdn?.ingestionInfo?.streamName ?? null,
  };
}

/** Thin YouTube Data API v3 client. `fetch` and the token source are injected for tests. */
export function createYouTubeClient({ getAccessToken, fetch = globalThis.fetch, baseUrl = BASE }) {
  async function call(method, path, { query = {}, body } = {}) {
    const url = new URL(`${baseUrl}/${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${await getAccessToken()}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new YouTubeApiError(res.status, json);
    return json;
  }

  const BROADCAST_PARTS = 'id,snippet,status,contentDetails';

  return {
    /** @param {'active'|'upcoming'|'completed'|'all'} status */
    async listBroadcasts(status = 'all') {
      const j = await call('GET', 'liveBroadcasts', { query: { part: BROADCAST_PARTS, broadcastStatus: status, maxResults: '25' } });
      return (j.items ?? []).map(toBroadcast);
    },
    async getBroadcast(id) {
      const j = await call('GET', 'liveBroadcasts', { query: { part: BROADCAST_PARTS, id } });
      return toBroadcast(j.items?.[0]);
    },
    async getStream(id) {
      const j = await call('GET', 'liveStreams', { query: { part: 'id,snippet,cdn,status', id } });
      return toStream(j.items?.[0]);
    },
    async listStreams() {
      const j = await call('GET', 'liveStreams', { query: { part: 'id,snippet,cdn,status', mine: 'true', maxResults: '25' } });
      return (j.items ?? []).map(toStream);
    },
    async createStream({ title, resolution = 'variable', frameRate = 'variable' }) {
      const j = await call('POST', 'liveStreams', {
        query: { part: 'id,snippet,cdn,status' },
        body: { snippet: { title }, cdn: { ingestionType: 'rtmp', resolution, frameRate }, contentDetails: { isReusable: true } },
      });
      return toStream(j);
    },
    async getViewers(videoId) {
      const j = await call('GET', 'videos', { query: { part: 'liveStreamingDetails', id: videoId } });
      const n = j.items?.[0]?.liveStreamingDetails?.concurrentViewers;
      return n === undefined ? null : Number(n);
    },
    async transition(id, broadcastStatus) {
      const j = await call('POST', 'liveBroadcasts/transition', { query: { part: BROADCAST_PARTS, id, broadcastStatus } });
      return toBroadcast(j);
    },
    async createBroadcast({ title, description = '', scheduledStart, privacy = 'unlisted', enableAutoStart = false, enableAutoStop = false }) {
      const j = await call('POST', 'liveBroadcasts', {
        query: { part: BROADCAST_PARTS },
        body: {
          snippet: { title, description, scheduledStartTime: scheduledStart },
          status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
          contentDetails: { enableAutoStart, enableAutoStop, enableClosedCaptions: true, monitorStream: { enableMonitorStream: true } },
        },
      });
      return toBroadcast(j);
    },
    async updateBroadcast(current, patch) {
      const j = await call('PUT', 'liveBroadcasts', {
        query: { part: 'id,snippet,status' },
        body: {
          id: current.id,
          snippet: {
            title: patch.title ?? current.title,
            description: patch.description ?? current.description,
            scheduledStartTime: patch.scheduledStart ?? current.scheduledStart,
          },
          status: { privacyStatus: patch.privacy ?? current.privacy },
        },
      });
      return toBroadcast(j);
    },
    async bind(id, streamId) {
      const j = await call('POST', 'liveBroadcasts/bind', { query: { part: BROADCAST_PARTS, id, streamId } });
      return toBroadcast(j);
    },
  };
}

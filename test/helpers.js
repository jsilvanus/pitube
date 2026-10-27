import { createEventBus } from '../src/events.js';
import { loadConfig } from '../src/config.js';

export const config = (over = {}) => ({ ...loadConfig({ PITUBE_API_TOKEN: 't', PITUBE_DATA_DIR: '/tmp/pitube-test' }), ...over });

export function fakeYouTube(initial = {}) {
  const state = {
    broadcast: { id: 'b1', title: 'Messu', lifeCycleStatus: 'ready', boundStreamId: 's1', scheduledStart: '2026-11-01T08:00:00Z', privacy: 'unlisted' },
    stream: { id: 's1', streamStatus: 'active', health: 'good', streamName: 'KEY-123', ingestionAddress: 'rtmp://a' },
    viewers: 7, calls: [], ...initial,
  };
  const yt = {
    state,
    async listBroadcasts(s) {
      state.calls.push(['list', s]);
      const lc = state.broadcast?.lifeCycleStatus;
      if (!state.broadcast) return [];
      const isActive = lc === 'live' || lc === 'testing';
      return (s === 'active') === isActive || s === 'all' ? [state.broadcast] : s === 'upcoming' && !isActive ? [state.broadcast] : [];
    },
    async getBroadcast() { return state.broadcast; },
    async getStream() { return state.stream; },
    async listStreams() { return [state.stream]; },
    async createStream() { return state.stream; },
    async getViewers() { return state.viewers; },
    async transition(id, to) { state.calls.push(['transition', to]); state.broadcast = { ...state.broadcast, lifeCycleStatus: to }; return state.broadcast; },
    async createBroadcast(f) { return { ...state.broadcast, ...f, id: 'new' }; },
    async updateBroadcast(cur, patch) { return { ...cur, ...patch }; },
    async bind(id, streamId) { return { ...state.broadcast, id, boundStreamId: streamId }; },
  };
  return yt;
}

export function setup(over = {}, ytInit) {
  const events = createEventBus();
  const seen = [];
  events.subscribe((e) => seen.push(e));
  return { events, seen, youtube: fakeYouTube(ytInit), config: config(over) };
}

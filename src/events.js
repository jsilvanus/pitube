import { EventEmitter } from 'node:events';

/** In-process event bus; the SSE route and other modules subscribe here. */
export function createEventBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  return {
    publish(type, data = {}) {
      emitter.emit('event', { type, data, at: new Date().toISOString() });
    },
    subscribe(fn) {
      emitter.on('event', fn);
      return () => emitter.off('event', fn);
    },
  };
}

import { useEffect, useRef, useState } from 'react';
import { buildApiUrl } from '../config/apiConfig';

const EVENT_NAMES = ['hello', 'log', 'stats', 'config', 'rules', 'logs-cleared'];

/**
 * Subscribe to the proxy's Server-Sent Events stream (`GET /api/events`).
 *
 * `handlers` maps event names to callbacks receiving the parsed `data`; the
 * latest handlers are always used, so callers can pass fresh closures on
 * every render without reconnecting. The browser's EventSource reconnects on
 * its own after an error.
 *
 * @param {Object<string, (data: any, event: MessageEvent) => void>} handlers
 * @param {{ enabled?: boolean }} [options]
 * @returns {boolean} True while the stream is open; callers keep polling only
 *   when it is false (no stream, or a connection currently being retried).
 */
export function useProxyEvents(handlers, { enabled = true } = {}) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') {
      setConnected(false);
      return undefined;
    }

    const source = new EventSource(buildApiUrl('/api/events'));

    const listeners = EVENT_NAMES.map((name) => {
      const listener = (event) => {
        let data = null;
        try {
          data = event.data ? JSON.parse(event.data) : null;
        } catch {
          data = null;
        }
        const handler = handlersRef.current ? handlersRef.current[name] : null;
        if (typeof handler === 'function') {
          handler(data, event);
        }
      };
      source.addEventListener(name, listener);
      return [name, listener];
    });

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    return () => {
      listeners.forEach(([name, listener]) => source.removeEventListener(name, listener));
      source.close();
      setConnected(false);
    };
  }, [enabled]);

  return connected;
}

// Поднимает настоящий сервер на свободном порту с движком-заглушкой.
// Порт 0 — чтобы параллельные тестовые файлы не дрались за один номер.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, '..', '..', 'public');

export async function startTestServer() {
  const { App } = await import('../../src/server/main.mjs');
  const { createRouter } = await import('../../src/server/http.mjs');

  const app = new App({ engineInfo: null, useMockEngine: true });
  await app.start();

  const server = http.createServer(createRouter({ app, publicDir: PUBLIC_DIR }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  return {
    app,
    base,
    async get(pathname) {
      const res = await fetch(base + pathname);
      return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
    },
    async post(pathname, body) {
      const res = await fetch(base + pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await app.dispose();
    },
  };
}

/**
 * Клиент потока событий: читает SSE напрямую из fetch-потока.
 * EventSource в Node есть, но собственный разбор даёт доступ к сырым кадрам,
 * а именно их формат мы и проверяем.
 */
export async function openStream(base, { lastEventId = null } = {}) {
  const headers = { Accept: 'text/event-stream' };
  if (lastEventId !== null) headers['Last-Event-ID'] = String(lastEventId);
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers, signal: controller.signal });

  const events = [];
  const waiters = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const frame = { id: null, event: 'message', data: '' };
          for (const line of raw.split('\n')) {
            if (line.startsWith('id: ')) frame.id = Number(line.slice(4));
            else if (line.startsWith('event: ')) frame.event = line.slice(7);
            else if (line.startsWith('data: ')) frame.data += line.slice(6);
          }
          if (frame.event === 'message' && !frame.data) continue; // heartbeat
          try {
            frame.json = JSON.parse(frame.data);
          } catch {
            frame.json = null;
          }
          events.push(frame);
          for (const w of waiters.slice()) {
            if (w.test(frame)) {
              waiters.splice(waiters.indexOf(w), 1);
              w.resolve(frame);
            }
          }
        }
      }
    } catch {
      /* поток закрыт — это штатное завершение */
    }
  })();

  return {
    events,
    headers: res.headers,
    /** Дождаться кадра, удовлетворяющего условию (или уже пришедшего). */
    waitFor(test, timeoutMs = 4000) {
      const hit = events.find(test);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { test, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) {
            waiters.splice(i, 1);
            reject(new Error('не дождались кадра за отведённое время'));
          }
        }, timeoutMs);
      });
    },
    close() {
      controller.abort();
    },
  };
}

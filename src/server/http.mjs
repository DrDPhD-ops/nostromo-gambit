// Маршрутизатор на node:http. Никаких фреймворков — маршрутов девять.
import { createStaticHandler } from './static.mjs';

const MAX_BODY = 64 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('слишком большое тело запроса'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** Код ошибки -> HTTP-статус. Одна таблица вместо разбросанных чисел. */
const STATUS = {
  STALE_VERSION: 409,
  DROP_IN_PROGRESS: 409,
  GAME_OVER: 409,
  NO_TOKENS: 409,
  NOT_YOUR_TURN: 409,
  NOTHING_TO_UNDO: 409,
  ILLEGAL_MOVE: 422,
  PROMOTION_REQUIRED: 422,
  BAD_REQUEST: 400,
  ENGINE_UNAVAILABLE: 503,
};

export function createRouter({ app, publicDir }) {
  const serveStatic = createStaticHandler(publicDir);
  const isTest = process.env.NODE_ENV === 'test';

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    try {
      if (req.method === 'GET' && p === '/api/state') {
        return sendJson(res, 200, app.snapshot());
      }

      if (req.method === 'GET' && p === '/api/events') {
        app.attachEventStream(req, res);
        return undefined;
      }

      if (req.method === 'GET' && p === '/health') {
        return sendJson(res, 200, app.health());
      }

      if (req.method === 'POST') {
        let body;
        try {
          body = await readJson(req);
        } catch {
          return sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', message: 'НЕЧИТАЕМЫЙ ЗАПРОС' });
        }

        // Оптимистичная конкурентность: клиент сообщает версию, которую видел.
        // Расхождение означает, что он смотрит на устаревшее состояние.
        const needsVersion = ['/api/move', '/api/roll', '/api/undo'];
        if (needsVersion.includes(p) && body.version !== undefined && body.version !== app.game.version) {
          return sendJson(res, 409, {
            ok: false,
            code: 'STALE_VERSION',
            message: 'СОСТОЯНИЕ УСТАРЕЛО',
            version: app.game.version,
          });
        }

        let result;
        if (p === '/api/move') result = await app.handleMove(body);
        else if (p === '/api/roll') result = await app.handleRoll(body);
        else if (p === '/api/new-game') result = await app.handleNewGame(body);
        else if (p === '/api/undo') result = await app.handleUndo(body);
        else if (p === '/api/settings') result = await app.handleSettings(body);
        else if (p === '/api/_test/fen' && isTest) result = await app.handleTestFen(body);
        else result = null;

        if (result === null) {
          return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: 'НЕТ ТАКОГО МАРШРУТА' });
        }
        if (!result.ok) {
          return sendJson(res, STATUS[result.code] || 400, result);
        }
        return sendJson(res, 200, result);
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        const served = await serveStatic(req, res, p);
        if (served) return undefined;
      }

      return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: 'НЕ НАЙДЕНО' });
    } catch (err) {
      // Ошибку показываем, но не роняем сервер: партия должна пережить сбой.
      console.error('[http] необработанная ошибка:', err);
      if (!res.headersSent) {
        return sendJson(res, 500, { ok: false, code: 'INTERNAL', message: 'ВНУТРЕННЯЯ ОШИБКА СЕРВЕРА' });
      }
      return undefined;
    }
  };
}

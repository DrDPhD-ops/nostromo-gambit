// Вход по общему паролю — для запуска на внешнем сервере.
//
// Партия на сервере одна, а поиск десанта занимает все ядра. Открытый адрес
// означал бы, что любой прохожий сбрасывает чужую игру и нагружает движки.
// Локально (127.0.0.1) шлюз не нужен, и main.mjs его не включает.
//
// Сессия — cookie с подписанным сроком годности, без хранилища на сервере:
// контейнер может перезапуститься в любой момент, и игроков это не разлогинит.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const COOKIE = 'ng_session';
const MAX_BODY = 4 * 1024;

// Лимит на один адрес ловит случайный перебор. Общий лимит нужен потому, что
// X-Forwarded-For пишет сам клиент: подменяя его, лимит по адресу можно обойти.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_IP = 10;
const MAX_FAILS_TOTAL = 100;

function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

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
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx !== -1 && part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return '';
}

/** Счётчик неудачных попыток в скользящем окне. */
class FailWindow {
  constructor(limit) {
    this.limit = limit;
    this.count = 0;
    this.resetAt = 0;
  }

  #roll() {
    if (Date.now() > this.resetAt) {
      this.count = 0;
      this.resetAt = Date.now() + WINDOW_MS;
    }
  }

  blocked() {
    this.#roll();
    return this.count >= this.limit;
  }

  note() {
    this.#roll();
    this.count += 1;
  }
}

export function createPasswordGate(handler, { password, publicDir, ttlDays = 30, cookieSecure = 'auto' }) {
  if (!password) throw new Error('createPasswordGate: пустой пароль');

  // Подпись выводится из пароля: смена пароля разом выкидывает все старые сессии.
  const secret = crypto.createHash('sha256').update(`nostromo-gambit:${password}`).digest();
  const passwordDigest = crypto.createHash('sha256').update(password).digest();
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  const loginPage = path.join(publicDir, 'login.html');

  const failsByIp = new Map();
  const failsTotal = new FailWindow(MAX_FAILS_TOTAL);

  function ipWindow(ip) {
    let w = failsByIp.get(ip);
    if (!w) {
      // Карта не должна расти бесконечно от подменённых адресов.
      if (failsByIp.size > 10_000) failsByIp.clear();
      w = new FailWindow(MAX_FAILS_PER_IP);
      failsByIp.set(ip, w);
    }
    return w;
  }

  function clientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
  }

  function passwordMatches(candidate) {
    if (typeof candidate !== 'string') return false;
    const digest = crypto.createHash('sha256').update(candidate).digest();
    return crypto.timingSafeEqual(digest, passwordDigest);
  }

  function sign(expiresAt) {
    const payload = String(expiresAt);
    return `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
  }

  function authenticated(req) {
    const token = readCookie(req, COOKIE);
    const dot = token.lastIndexOf('.');
    if (dot === -1) return false;
    const payload = token.slice(0, dot);
    const mac = Buffer.from(token.slice(dot + 1), 'base64url');
    const expected = crypto.createHmac('sha256', secret).update(payload).digest();
    if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return false;
    const expiresAt = Number(payload);
    return Number.isFinite(expiresAt) && Date.now() < expiresAt;
  }

  function cookie(req, value, maxAgeSeconds) {
    const secure =
      cookieSecure === 'true' ||
      (cookieSecure === 'auto' && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
    const bits = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
    if (secure) bits.push('Secure');
    return bits.join('; ');
  }

  return async function gated(req, res) {
    const p = new URL(req.url, 'http://127.0.0.1').pathname;

    // Проверка живости для хостинга — без входа, иначе платформа сочтёт сервис мёртвым.
    if (p === '/health') return handler(req, res);

    if (req.method === 'POST' && p === '/api/login') {
      const ipFails = ipWindow(clientIp(req));
      if (ipFails.blocked() || failsTotal.blocked()) {
        return sendJson(res, 429, { ok: false, code: 'TOO_MANY_ATTEMPTS', message: 'СЛИШКОМ МНОГО ПОПЫТОК. ЖДИТЕ 15 МИНУТ' });
      }
      let body;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', message: 'НЕЧИТАЕМЫЙ ЗАПРОС' });
      }
      if (!passwordMatches(body.password)) {
        ipFails.note();
        failsTotal.note();
        return sendJson(res, 401, { ok: false, code: 'BAD_PASSWORD', message: 'КОД ДОСТУПА НЕ ПРИНЯТ' });
      }
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, sign(Date.now() + ttlMs), Math.floor(ttlMs / 1000)) });
    }

    if (req.method === 'POST' && p === '/api/logout') {
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
    }

    if (p === '/login' || p === '/login.html') {
      if (authenticated(req)) return redirect(res, '/');
      try {
        const page = await fs.readFile(loginPage);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(page);
      } catch {
        return sendJson(res, 500, { ok: false, code: 'INTERNAL', message: 'НЕТ СТРАНИЦЫ ВХОДА' });
      }
    }

    if (!authenticated(req)) {
      if (p.startsWith('/api/')) {
        return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'НУЖЕН ВХОД' });
      }
      return redirect(res, '/login');
    }

    // Клиент спрашивает это, чтобы решить, показывать ли кнопку выхода.
    if (req.method === 'GET' && p === '/api/session') {
      return sendJson(res, 200, { ok: true, auth: true });
    }

    return handler(req, res);
  };
}

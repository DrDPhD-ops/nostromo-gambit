// Отдача статики из public/.
//
// Две вещи, на которых обычно спотыкаются: charset в заголовке (без него кириллица
// превращается в кракозябры даже при правильном <meta>) и выход за пределы каталога.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

export function createStaticHandler(root) {
  const rootResolved = path.resolve(root);

  return async function serve(req, res, urlPath) {
    let rel = decodeURIComponent(urlPath);
    if (rel === '/' || rel === '') rel = '/index.html';

    // Собираем путь и убеждаемся, что он не вышел из корня. Проверять надо
    // ПОСЛЕ разрешения: '/../..' и его закодированные формы иначе проходят.
    const target = path.resolve(rootResolved, `.${rel}`);
    if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ВЫХОД ЗА ПРЕДЕЛЫ КАТАЛОГА');
      return true;
    }

    let body;
    try {
      const stat = await fs.stat(target);
      if (stat.isDirectory()) return false;
      body = await fs.readFile(target);
    } catch {
      return false;
    }

    const etag = `W/"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      res.end();
      return true;
    }

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      ETag: etag,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}

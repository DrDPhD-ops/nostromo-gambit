#!/usr/bin/env node
// Сервер для сквозной проверки интерфейса.
//
// Движок — заглушка: проверяется интерфейс и протокол, а не качество десанта.
// Настоящий Stockfish здесь только замедлил бы прогон и сделал его недетерминированным.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from '../../src/server/main.mjs';
import { createRouter } from '../../src/server/http.mjs';

process.env.NODE_ENV = 'test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, '..', '..', 'public');
const PORT = Number(process.env.PORT || 7799);

const app = new App({ engineInfo: null, useMockEngine: true });
await app.start();

const server = http.createServer(createRouter({ app, publicDir: PUBLIC_DIR }));
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

console.log(`E2E-сервер (движок-заглушка): http://127.0.0.1:${PORT}`);
console.log('Проверочный список:');
console.log('  1. стартовый экран показывает все параметры операции');
console.log('  2. кнопка «НАЧАТЬ ОПЕРАЦИЮ» открывает доску');
console.log('  3. ход двумя кликами появляется в журнале ходов');
console.log('  4. бросок кубиков тратит жетон и запускает высадку');
console.log('  5. после высадки поля подсвечены, в журнале есть строка с Δ');
console.log('  6. перезагрузка страницы сохраняет позицию и журналы');
console.log('  7. вторая вкладка видит ход, сделанный в первой');
console.log('  8. мат показывает оверлей окончания партии');

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, async () => {
    server.close();
    await app.dispose();
    process.exit(0);
  });
}

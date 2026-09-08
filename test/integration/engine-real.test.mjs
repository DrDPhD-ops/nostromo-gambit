// Тесты на НАСТОЯЩЕМ Stockfish. Пропускаются, если движок не установлен.
//
// Здесь только то, что заглушка доказать не может: проволочный протокол,
// поведение процессов в этой операционной системе и границы, за которыми
// движок перестаёт работать.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { UciEngine } from '../../src/engine/uci.mjs';
import { EnginePool } from '../../src/engine/pool.mjs';
import { readJsonSafe, CURRENT_JSON } from '../../src/shared/paths.mjs';
import { scoreToCp } from '../../src/engine/evaluate.mjs';
import { normalizeForComparison } from '../../src/game/fen.mjs';
import { registeredPids } from '../../src/engine/registry.mjs';

const engineInfo = readJsonSafe(CURRENT_JSON);
const available = Boolean(engineInfo && engineInfo.path && fs.existsSync(engineInfo.path));
const skip = available ? false : 'движок не установлен (npm run setup)';

/** Каталог проекта пользователя: кириллица, пробел и виртуальный диск Google Drive. */
const CYRILLIC_DIR = 'G:\\Другие компьютеры\\PAULEKMAN\\dev';

const MID = 'r4rk1/pp3ppp/2n5/2pp4/8/2P1PN2/PP3PPP/R4RK1 w - - 0 18';

function makeEngine(extra = {}) {
  return new UciEngine({ exePath: engineInfo.path, args: engineInfo.args || [], ...extra });
}

test('движок отзывается тем же именем, что записано при установке', { skip }, async () => {
  const e = makeEngine();
  await e.start();
  try {
    assert.match(e.id, /^Stockfish/);
    assert.equal(e.id, engineInfo.uciName);
  } finally {
    await e.dispose();
  }
});

test('запуск с рабочим каталогом в кириллическом пути', { skip }, async (t) => {
  // Прямая проверка риска: каталог проекта пользователя лежит на диске G:
  // и содержит кириллицу с пробелом. Бинарь движка живёт в ASCII-пути под
  // %LOCALAPPDATA% именно для того, чтобы это не имело значения, но убедиться
  // стоит: одна такая поломка стоит часов недоумения.
  if (!fs.existsSync(CYRILLIC_DIR)) {
    t.skip(`каталог ${CYRILLIC_DIR} недоступен`);
    return;
  }
  const e = makeEngine({ cwd: CYRILLIC_DIR });
  await e.start();
  try {
    const r = await e.analyse({ fen: MID, nodes: 60000 });
    assert.ok(r.depth > 4, 'поиск обязан идти и из кириллического каталога');
    assert.equal(typeof scoreToCp(r.score), 'number');
  } finally {
    await e.dispose();
  }
});

test('FEN возвращается движком байт в байт', { skip }, async () => {
  // Один этот тест ловит все расхождения по взятию на проходе, правам рокировки
  // и счётчику 50 ходов между нашей нормализацией и тем, как понял позицию движок.
  const e = makeEngine();
  await e.start();
  try {
    for (const fen of [
      MID,
      'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1',
      normalizeForComparison('8/5pk1/6p1/7p/7P/5PK1/6P1/8 w - - 84 90'),
    ]) {
      assert.equal(await e.debugFen(fen), fen, `движок понял позицию иначе: ${fen}`);
    }
  } finally {
    await e.dispose();
  }
});

test('стартовая позиция оценивается около нуля', { skip }, async () => {
  const e = makeEngine();
  await e.start();
  try {
    const r = await e.analyse({ fen: 'startpos', nodes: 300000 });
    const cp = scoreToCp(r.score);
    assert.ok(Math.abs(cp) < 80, `оценка старта ${cp} сп выглядит неправдоподобно`);
  } finally {
    await e.dispose();
  }
});

test('лишняя фигура видна как большой перевес', { skip }, async () => {
  const e = makeEngine();
  await e.start();
  try {
    // Ферзь на d2, а не на e2: с e2 он бьёт чёрного короля по открытой вертикали
    // при ходе белых, и такой позиции не существует.
    const r = await e.analyse({ fen: '4k3/8/8/8/8/8/3Q4/4K3 w - - 0 1', nodes: 300000 });
    assert.ok(scoreToCp(r.score) > 500, 'лишний ферзь обязан быть заметен');
  } finally {
    await e.dispose();
  }
});

test('после остановки пула не остаётся живых движков', { skip }, async () => {
  const pool = new EnginePool({
    exePath: engineInfo.path,
    args: engineInfo.args || [],
    size: 2,
    warmupNodes: 0,
    options: { Threads: 1, Hash: 16 },
  });
  await pool.start();
  await pool.analyse({ fen: MID, nodes: 30000 });
  // Запоминаем ИМЕННО СВОИ процессы. Считать все stockfish.exe в системе нельзя:
  // рядом может идти ночной прогон, и тест ловил бы чужие движки.
  const mine = registeredPids();
  assert.ok(mine.length >= 2, 'движки пула обязаны попасть в реестр');
  await pool.dispose();

  if (process.platform !== 'win32') return;
  // Спрашиваем саму систему, а не свои структуры: смысл проверки в том,
  // что процессов действительно нет, а не в том, что мы так думаем.
  const res = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `@(${mine.join(',')}) | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }`,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 },
  );
  if (res.status !== 0) return; // не смогли спросить — не выдумываем ответ
  const stillAlive = String(res.stdout).trim();
  assert.equal(stillAlive, '', `после остановки пула остались живы наши PID: ${stillAlive}`);
});

test('десант в 33-ю фигуру не отправляется движку', { skip }, async () => {
  // Граница проверена экспериментально: на 33 фигурах движок завершается с кодом 1.
  // Проверяем, что наша защита срабатывает РАНЬШЕ, чем это случится.
  const { enginePositionProblem } = await import('../../src/game/dropRules.mjs');
  const thirtyThree = 'rnbqkbnr/pppppppp/8/8/8/N7/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  assert.ok(enginePositionProblem(thirtyThree), 'позиция обязана быть отвергнута до отправки');

  // И убеждаемся, что запрет не ложный: 32 фигуры движок считает.
  const e = makeEngine();
  await e.start();
  try {
    const r = await e.analyse({ fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', nodes: 60000 });
    assert.ok(r.depth > 4);
  } finally {
    await e.dispose();
  }
});

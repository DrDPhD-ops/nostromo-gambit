import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UciEngine, EngineError, ERR } from '../../src/engine/uci.mjs';
import { scoreToCp } from '../../src/engine/evaluate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, '..', 'fixtures', 'fake-engine.mjs');

/** Поддельный движок — настоящий дочерний процесс, запускаемый тем же node. */
function makeEngine(flags = [], options = {}) {
  return new UciEngine({ exePath: process.execPath, args: [FAKE, ...flags], options, label: 'fake' });
}

const MIDDLEGAME = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';

test('хендшейк: разбирает имя и список опций', async () => {
  const e = makeEngine();
  await e.start();
  try {
    assert.equal(e.id, 'FakeFish 1.0');
    assert.ok(e.uciOptions.has('Threads'));
    assert.ok(e.uciOptions.has('MultiPV'));
    assert.ok(e.alive);
    assert.equal(e.busy, false);
  } finally {
    await e.dispose();
  }
});

test('хендшейк падает по таймауту, если движок молчит', async () => {
  const e = makeEngine(['--no-uciok']);
  await assert.rejects(
    () => e.start({ handshakeTimeoutMs: 400 }),
    (err) => err instanceof EngineError && err.code === ERR.HANDSHAKE,
  );
  await e.dispose();
});

test('поиск возвращает кривую, оценку и ход', async () => {
  const e = makeEngine();
  await e.start();
  try {
    const r = await e.analyse({ fen: MIDDLEGAME, nodes: 50000 });
    assert.ok(r.depth >= 2, 'кривая должна быть непустой');
    assert.equal(typeof scoreToCp(r.score), 'number');
    assert.equal(r.best, 'e2e4');
    assert.ok(r.infoLines > 0);
  } finally {
    await e.dispose();
  }
});

test('строка с upperbound не попадает в оценку', async () => {
  const e = makeEngine();
  await e.start();
  try {
    // Поддельный движок на глубине 3 подсовывает строку с upperbound и оценкой +300
    // относительно базовой. Если бы разбор её принимал, кривая была бы загрязнена.
    const r = await e.analyse({ fen: MIDDLEGAME, nodes: 50000 });
    const atThree = r.curve.byDepth.get(3);
    assert.ok(atThree, 'глубина 3 должна быть в кривой');
    const atFour = r.curve.byDepth.get(4);
    assert.ok(Math.abs(atThree.value - atFour.value) < 100, 'оценка на глубине 3 не должна прыгать на +300');
  } finally {
    await e.dispose();
  }
});

test('одинаковый вход даёт одинаковый выход', async () => {
  const e = makeEngine();
  await e.start();
  try {
    const a = await e.analyse({ fen: MIDDLEGAME, nodes: 40000 });
    const b = await e.analyse({ fen: MIDDLEGAME, nodes: 40000 });
    assert.deepEqual(scoreToCp(a.score), scoreToCp(b.score));
    assert.equal(a.depth, b.depth);
  } finally {
    await e.dispose();
  }
});

test('вывод, разрезанный посреди строк, разбирается верно', async () => {
  const e = makeEngine(['--chunked']);
  await e.start();
  try {
    const r = await e.analyse({ fen: MIDDLEGAME, nodes: 30000 });
    assert.equal(r.best, 'e2e4', 'bestmove собран из кусков');
    assert.ok(r.depth >= 2);
  } finally {
    await e.dispose();
  }
});

test('вторая задача на занятом движке отвергается, а не портит протокол', async () => {
  const e = makeEngine(['--slow=8']);
  await e.start();
  try {
    const first = e.analyse({ fen: MIDDLEGAME, nodes: 60000 });
    await assert.rejects(
      () => e.analyse({ fen: MIDDLEGAME, nodes: 60000 }),
      (err) => err instanceof EngineError && err.code === ERR.BUSY,
    );
    await first; // первая обязана нормально доехать
  } finally {
    await e.dispose();
  }
});

test('движок, игнорирующий stop, отваливается по таймауту', async () => {
  const e = makeEngine(['--ignore-stop', '--slow=40']);
  await e.start();
  try {
    await assert.rejects(
      () => e.analyse({ fen: MIDDLEGAME, nodes: 5_000_000, timeoutMs: 250 }),
      (err) => err instanceof EngineError && err.code === ERR.TIMEOUT,
    );
  } finally {
    await e.dispose();
  }
});

test('падение движка приходит как ENGINE_CRASHED и как событие died', async () => {
  const e = makeEngine(['--crash-after=0']);
  await e.start();
  const died = new Promise((resolve) => e.once('died', resolve));
  try {
    await assert.rejects(
      () => e.analyse({ fen: MIDDLEGAME, nodes: 10000 }),
      (err) => err instanceof EngineError && err.code === ERR.CRASHED,
    );
    await died;
  } finally {
    await e.dispose();
  }
});

test('отмена через AbortSignal останавливает поиск и не ломает движок', async () => {
  const e = makeEngine(['--slow=10']);
  await e.start();
  try {
    const ac = new AbortController();
    const p = e.analyse({ fen: MIDDLEGAME, nodes: 2_000_000, signal: ac.signal, timeoutMs: 8000 });
    setTimeout(() => ac.abort(), 60);
    await assert.rejects(p, (err) => err instanceof EngineError && err.code === ERR.ABORTED);
    // Главное: после отмены движок остаётся пригодным.
    const r = await e.analyse({ fen: MIDDLEGAME, nodes: 20000 });
    assert.equal(r.best, 'e2e4');
  } finally {
    await e.dispose();
  }
});

test('staticEval читает оценку от лица белых', async () => {
  const e = makeEngine();
  await e.start();
  try {
    const cp = await e.staticEval(MIDDLEGAME);
    assert.equal(typeof cp, 'number');
    const again = await e.staticEval(MIDDLEGAME);
    assert.equal(cp, again, 'статическая оценка обязана быть детерминированной');
  } finally {
    await e.dispose();
  }
});

test('debugFen возвращает позицию так, как её понял движок', async () => {
  const e = makeEngine();
  await e.start();
  try {
    assert.equal(await e.debugFen(MIDDLEGAME), MIDDLEGAME);
  } finally {
    await e.dispose();
  }
});

test('dispose завершает процесс, даже если движок игнорирует quit', async () => {
  const e = makeEngine(['--slow-quit']);
  await e.start();
  const pid = e.pid;
  const t0 = Date.now();
  await e.dispose({ graceMs: 200 });
  assert.ok(Date.now() - t0 < 2000, 'останов не должен занимать секунды');
  assert.equal(e.alive, false);
  assert.ok(pid > 0);
});

test('после dispose новые задачи отвергаются', async () => {
  const e = makeEngine();
  await e.start();
  await e.dispose();
  await assert.rejects(
    () => e.analyse({ fen: MIDDLEGAME, nodes: 1000 }),
    (err) => err instanceof EngineError && err.code === ERR.SHUTDOWN,
  );
});

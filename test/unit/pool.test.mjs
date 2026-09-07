import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EnginePool, recommendedPoolSize } from '../../src/engine/pool.mjs';
import { MockEngine } from '../../src/engine/mock.mjs';
import { UciEngine, EngineError, ERR } from '../../src/engine/uci.mjs';
import { registeredPids } from '../../src/engine/registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, '..', 'fixtures', 'fake-engine.mjs');
const FEN = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';

function mockPool(size, opts = {}) {
  return new EnginePool({ createEngine: () => new MockEngine(opts), size, warmupNodes: 0 });
}

test('размер пула не забирает все логические ядра', () => {
  assert.equal(recommendedPoolSize(8), 5);
  assert.equal(recommendedPoolSize(4), 1);
  assert.equal(recommendedPoolSize(2), 1);
  assert.equal(recommendedPoolSize(32), 5, 'верхняя граница держится: смысла свыше нет');
});

test('одновременность не превышает размер пула', async () => {
  const pool = mockPool(4, { delayMs: 12 });
  await pool.start();
  try {
    await pool.map(Array.from({ length: 20 }, (_, i) => i), (engine) => engine.analyse({ fen: FEN, nodes: 1000 }));
    assert.equal(pool.peakConcurrency, 4, 'ровно 4, не больше и не меньше');
  } finally {
    await pool.dispose();
  }
});

test('срочные задачи обгоняют обычные', async () => {
  const pool = mockPool(1, { delayMs: 8 });
  await pool.start();
  const order = [];
  try {
    const first = pool.run(async () => {
      order.push('занял');
      await new Promise((r) => setTimeout(r, 40));
    });
    // Пока слот занят, ставим в очередь три обычных и одну срочную.
    const normals = [1, 2, 3].map((n) => pool.run(async () => order.push(`обычная-${n}`)));
    const urgent = pool.run(async () => order.push('срочная'), { priority: 'urgent' });
    await Promise.all([first, urgent, ...normals]);
    assert.equal(order[0], 'занял');
    assert.equal(order[1], 'срочная', 'срочная обязана пройти первой из очереди');
  } finally {
    await pool.dispose();
  }
});

test('результаты map сохраняют порядок входа', async () => {
  const pool = mockPool(3, { delayMs: 5 });
  await pool.start();
  try {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const out = await pool.map(items, async (_engine, item, i) => `${i}:${item}`);
    assert.deepEqual(out, ['0:a', '1:b', '2:c', '3:d', '4:e', '5:f', '6:g']);
  } finally {
    await pool.dispose();
  }
});

test('AbortSignal снимает задачу из очереди, не занимая движок', async () => {
  const pool = mockPool(1, { delayMs: 30 });
  await pool.start();
  try {
    const blocker = pool.run(() => new Promise((r) => setTimeout(r, 60)));
    const ac = new AbortController();
    let ran = false;
    const queued = pool.run(
      async () => {
        ran = true;
      },
      { signal: ac.signal },
    );
    ac.abort();
    await assert.rejects(queued, (err) => err instanceof EngineError && err.code === ERR.ABORTED);
    await blocker;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ran, false, 'снятая задача не должна выполниться');
  } finally {
    await pool.dispose();
  }
});

test('dispose отвергает очередь и не оставляет висящих обещаний', async () => {
  const pool = mockPool(1, { delayMs: 40 });
  await pool.start();
  const blocker = pool.run(() => new Promise((r) => setTimeout(r, 80)));
  const queued = pool.run(async () => 'не должно выполниться');
  const disposal = pool.dispose();
  await assert.rejects(queued, (err) => err instanceof EngineError && err.code === ERR.SHUTDOWN);
  await blocker;
  await disposal;
  await assert.rejects(
    () => pool.run(async () => 1),
    (err) => err instanceof EngineError && err.code === ERR.SHUTDOWN,
  );
});

test('калибровка возвращает совокупную скорость', async () => {
  const pool = mockPool(3, { delayMs: 10 });
  await pool.start();
  try {
    const { aggregateNps, workers } = await pool.calibrate({ nodes: 50000 });
    assert.equal(workers, 3);
    assert.ok(aggregateNps > 0, 'скорость должна быть положительной');
  } finally {
    await pool.dispose();
  }
});

test('упавший движок перезапускается, очередь дорабатывает', async () => {
  // Настоящие дочерние процессы: падение процесса — это то, чего mock не изображает.
  const pool = new EnginePool({
    createEngine: () => new UciEngine({ exePath: process.execPath, args: [FAKE, '--crash-after=1'] }),
    size: 2,
    warmupNodes: 0,
  });
  await pool.start();
  const deaths = [];
  pool.on('health', (h) => deaths.push(h.live));
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => pool.analyse({ fen: FEN, nodes: 5000 })),
    );
    const failed = results.filter((r) => r.status === 'rejected');
    assert.ok(failed.length > 0, 'часть задач обязана упасть вместе с движком');
    // Главное: пул пережил падения и не завис.
    assert.ok(results.length === 6);
  } finally {
    await pool.dispose();
  }
});

test('после dispose в реестре не остаётся наших PID', async () => {
  const pool = new EnginePool({
    createEngine: () => new UciEngine({ exePath: process.execPath, args: [FAKE] }),
    size: 2,
    warmupNodes: 0,
  });
  await pool.start();
  const before = registeredPids();
  assert.ok(before.length >= 2, 'запущенные движки должны попасть в реестр');
  await pool.dispose();
  const after = registeredPids();
  for (const pid of before) {
    assert.ok(!after.includes(pid), `PID ${pid} обязан исчезнуть из реестра после dispose`);
  }
});

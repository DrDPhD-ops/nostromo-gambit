import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';

import { makeRng } from '../../src/game/rng.mjs';
import { rollDice, interpretRoll, combineSkew, describeRoll, MAX_TOTAL_SKEW_CP } from '../../src/game/dice.mjs';
import { STORYTELLERS, getStoryteller, storytellerSkew, storytellerList } from '../../src/game/storytellers.mjs';
import {
  PACKAGES,
  samplePackage,
  packageFits,
  repairPackage,
  tonnageOf,
  nominalDelta,
  packageSize,
} from '../../src/game/packages.mjs';
import { fischerFen, randomBackRank, backRankIsValid } from '../../src/game/fischer.mjs';
import { LEVELS, getLevel, chooseComputerMove } from '../../src/game/computer.mjs';
import { EnginePool } from '../../src/engine/pool.mjs';
import { MockEngine } from '../../src/engine/mock.mjs';
import { countMaterial, checkLimits, freeSlots } from '../../src/game/fen.mjs';

const MID = 'r4rk1/pp3ppp/2n5/2pp4/8/2P1PN2/PP3PPP/R4RK1 w - - 0 18';

// ───────────────────────────────────────────── кубики

test('таблица 2d6 полна и монотонна по тоннажу', () => {
  const seen = new Set();
  for (let d1 = 1; d1 <= 6; d1++) {
    for (let d2 = 1; d2 <= 6; d2++) {
      const r = interpretRoll({ d1, d2 }, 'w');
      assert.ok(r.budgetCp > 0, 'тоннаж всегда положителен');
      assert.equal(r.sum, d1 + d2);
      assert.equal(r.spread, Math.abs(d1 - d2));
      seen.add(r.sum);
    }
  }
  assert.equal(seen.size, 11, 'суммы от 2 до 12 — одиннадцать значений');
  assert.ok(interpretRoll({ d1: 6, d2: 6 }, 'w').budgetCp > interpretRoll({ d1: 1, d2: 1 }, 'w').budgetCp);
});

test('дубль даёт нулевой перекос — за тоннаж платят наглостью', () => {
  for (let d = 1; d <= 6; d++) {
    assert.equal(interpretRoll({ d1: d, d2: d }, 'w').skewCp, 0);
  }
  // Максимальный разброс возможен только при средней сумме.
  const wild = interpretRoll({ d1: 6, d2: 1 }, 'w');
  assert.equal(wild.spread, 5);
  assert.equal(wild.sum, 7, 'выкрутить и тоннаж, и перекос одновременно нельзя');
});

test('знак перекоса всегда в пользу бросающего', () => {
  assert.ok(interpretRoll({ d1: 6, d2: 1 }, 'w').skewCp > 0, 'белым — в плюс');
  assert.ok(interpretRoll({ d1: 6, d2: 1 }, 'b').skewCp < 0, 'чёрным — в минус, это POV белых');
});

test('суммарный перекос клампится вместе с люфтом планировщика', () => {
  assert.equal(combineSkew(100, 80), MAX_TOTAL_SKEW_CP);
  assert.equal(combineSkew(-100, -80), -MAX_TOTAL_SKEW_CP);
  assert.equal(combineSkew(40, -20), 20);
  assert.equal(combineSkew(0, 0), 0);
});

test('бросок воспроизводится по сиду', () => {
  const a = rollDice(makeRng('dice-seed'));
  const b = rollDice(makeRng('dice-seed'));
  assert.deepEqual(a, b);
  assert.ok(describeRoll(interpretRoll(a, 'w')).includes('ТОННАЖ'));
});

// ───────────────────────────────────────────── планировщики

test('три планировщика различаются допуском и характером', () => {
  const list = storytellerList();
  assert.equal(list.length, 3);
  assert.ok(STORYTELLERS.mother.toleranceCp < STORYTELLERS.bishop.toleranceCp);
  // МАТЬ штрафует остроту, ЭШ её награждает — знаки весов обязаны быть противоположны.
  assert.ok(STORYTELLERS.mother.weights.spread > 0, 'МАТЬ минимизирует разброс оценки');
  assert.ok(STORYTELLERS.ash.weights.spread < 0, 'ЭШ его максимизирует');
  assert.ok(STORYTELLERS.mother.weights.mirrorBonus < 0, 'МАТЬ награждает зеркальность');
  assert.ok(STORYTELLERS.ash.weights.mirrorBonus > 0, 'ЭШ её штрафует');
  assert.ok(STORYTELLERS.ash.autoEveryFullMoves < STORYTELLERS.mother.autoEveryFullMoves);
});

test('люфт есть только у ЭША и не выходит за свой предел', () => {
  const rng = makeRng('skew');
  assert.equal(storytellerSkew(STORYTELLERS.mother, rng), 0);
  assert.equal(storytellerSkew(STORYTELLERS.bishop, rng), 0);
  let sawPlus = false;
  let sawMinus = false;
  for (let i = 0; i < 200; i++) {
    const v = storytellerSkew(STORYTELLERS.ash, rng);
    assert.ok(Math.abs(v) <= STORYTELLERS.ash.skewCp, `люфт ${v} вышел за предел`);
    if (v > 0) sawPlus = true;
    if (v < 0) sawMinus = true;
  }
  assert.ok(sawPlus && sawMinus, 'знак обязан гулять: иначе это правило игры, а не непредсказуемость');
});

test('неизвестный планировщик откатывается к БИШОПУ', () => {
  assert.equal(getStoryteller('нет такого').id, 'bishop');
});

// ───────────────────────────────────────────── наборы

test('в таблице наборов есть асимметричные по составу', () => {
  const asym = PACKAGES.filter((p) => p.w.length !== p.b.length);
  assert.ok(asym.length > 10, 'асимметрия — смысл механики, её должно быть много');
  for (const p of PACKAGES) {
    assert.ok(p.w.length > 0 && p.b.length > 0, 'обе стороны обязаны что-то получить');
    assert.ok(tonnageOf(p) > 0);
    assert.equal(packageSize(p), p.w.length + p.b.length);
  }
});

test('каждая строка таблицы разворачивается в обе стороны', () => {
  const key = (p) => `${p.w.join('')}|${p.b.join('')}`;
  const keys = new Set(PACKAGES.map(key));
  for (const p of PACKAGES) {
    if (key(p) === `${p.b.join('')}|${p.w.join('')}`) continue; // симметричные
    assert.ok(keys.has(`${p.b.join('')}|${p.w.join('')}`), `нет зеркальной строки для ${key(p)}`);
  }
});

test('на полной доске набор не выбирается вовсе', () => {
  const rng = makeRng('pkg');
  const full = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  assert.equal(samplePackage(rng, { fen: full, budgetCp: 400 }), null);
});

test('выбранный набор всегда влезает в позицию', () => {
  const rng = makeRng('pkg2');
  for (let i = 0; i < 60; i++) {
    const pkg = samplePackage(rng, { fen: MID, budgetCp: 200 + i * 20 });
    assert.ok(pkg, 'в этой позиции набор обязан находиться');
    assert.ok(packageFits(MID, pkg), `набор ${pkg.w}/${pkg.b} не влезает`);
    assert.ok(packageSize(pkg) <= freeSlots(MID));
  }
});

test('набор не создаёт недостижимую позицию', () => {
  // 8 пешек у белых: наборы с третьей ладьёй обязаны отсеиваться.
  const eightPawns = '4k3/8/8/8/8/8/PPPPPPPP/R3K2R w - - 0 1';
  const bad = { w: ['r'], b: ['p'], id: 'test' };
  assert.equal(packageFits(eightPawns, bad), false);
});

test('гроссбух смещает выбор в сторону отстающего', () => {
  const count = (ledger) => {
    const rng = makeRng(`ledger-${ledger}`);
    let sum = 0;
    for (let i = 0; i < 300; i++) {
      const p = samplePackage(rng, { fen: MID, budgetCp: 400, ledgerCp: ledger });
      if (p) sum += nominalDelta(p);
    }
    return sum;
  };
  // Если белым уже выдали лишнего, наборы должны крениться в пользу чёрных.
  assert.ok(count(300) < count(-300), 'гроссбух обязан работать в обе стороны');
});

test('ремонт набора добавляет вес нужной стороне', () => {
  const pkg = PACKAGES.find((p) => p.w.join('') === 'n' && p.b.join('') === 'b');
  const fixed = repairPackage(pkg, 'w', { fen: MID });
  assert.ok(fixed, 'ремонт обязан найтись');
  assert.ok(nominalDelta(fixed) > nominalDelta(pkg), 'вес белых обязан вырасти');
  assert.ok(packageFits(MID, fixed), 'починенный набор обязан влезать');
});

test('ремонт находит замену, когда пешку добавить некуда', () => {
  // У белых уже восемь пешек: девятая сделала бы позицию недостижимой,
  // и ремонт обязан взять фигуру потяжелее, а не сдаться.
  const eightPawns = '4k3/8/8/8/8/8/PPPPPPPP/4K3 w - - 0 1';
  const pkg = { w: ['n'], b: ['b'], id: 'test' };
  const fixed = repairPackage(pkg, 'w', { fen: eightPawns });
  assert.ok(fixed, 'ремонт обязан найтись и здесь');
  assert.ok(!fixed.w.includes('p') || fixed.w.filter((t) => t === 'p').length === 0);
  assert.ok(packageFits(eightPawns, fixed));
});

// ───────────────────────────────────────────── расстановка Фишера

test('расстановка Фишера соблюдает правила 960', () => {
  const rng = makeRng('fischer');
  for (let i = 0; i < 300; i++) {
    const row = randomBackRank(rng);
    assert.ok(backRankIsValid(row), `недопустимая расстановка: ${row.join('')}`);
  }
});

test('стандартная расстановка проходит проверку 960, а сломанные — нет', () => {
  assert.equal(backRankIsValid(['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r']), true);
  assert.equal(backRankIsValid(['k', 'r', 'b', 'q', 'n', 'b', 'n', 'r']), false, 'король левее обеих ладей');
  // Слоны на 2 и 5: чётное и нечётное поле, то есть разного цвета; король между ладьями.
  assert.equal(backRankIsValid(['r', 'n', 'b', 'n', 'k', 'b', 'q', 'r']), true, 'корректная расстановка 960');
  assert.equal(backRankIsValid(['b', 'b', 'n', 'q', 'k', 'r', 'n', 'r']), false, 'слоны одного цвета');
});

test('FEN Фишера легален и воспроизводим по сиду', () => {
  const a = fischerFen(makeRng('seed-1'));
  const b = fischerFen(makeRng('seed-1'));
  assert.equal(a, b, 'одинаковый сид — одинаковая расстановка');
  const chess = new Chess(a);
  assert.equal(countMaterial(a).total, 32);
  assert.deepEqual(checkLimits(a), []);
  assert.ok(chess.moves().length > 0);
  // Рокировка в этом режиме отключена осознанно — chess.js её в 960 не умеет.
  assert.ok(a.includes(' w - - 0 1'), 'права рокировки должны быть сняты');
});

// ───────────────────────────────────────────── компьютерный игрок

test('уровни идут по возрастанию силы', () => {
  for (let i = 1; i < LEVELS.length; i++) {
    assert.ok(LEVELS[i].nodes > LEVELS[i - 1].nodes, 'бюджет узлов обязан расти');
    assert.ok(LEVELS[i].slackCp <= LEVELS[i - 1].slackCp, 'допуск на неточность обязан падать');
  }
  assert.equal(getLevel(99).id, 3, 'неизвестный уровень откатывается к среднему');
  assert.equal(LEVELS[LEVELS.length - 1].slackCp, 0, 'на максимуме поблажек нет');
});

test('компьютер выбирает легальный ход', async () => {
  const pool = new EnginePool({ createEngine: () => new MockEngine(), size: 2, warmupNodes: 0 });
  await pool.start();
  try {
    const rng = makeRng('cpu');
    for (const level of [1, 3, 5]) {
      const move = await chooseComputerMove(pool, MID, { level, rng });
      assert.ok(move, 'ход обязан найтись');
      const chess = new Chess(MID);
      const legal = chess.moves({ verbose: true });
      assert.ok(
        legal.some((m) => m.from === move.from && m.to === move.to),
        `${move.from}${move.to} нет среди легальных`,
      );
    }
  } finally {
    await pool.dispose();
  }
});

test('в позиции без ходов компьютер возвращает null, а не падает', async () => {
  const pool = new EnginePool({ createEngine: () => new MockEngine(), size: 1, warmupNodes: 0 });
  await pool.start();
  try {
    // Мат: ходов нет вовсе.
    const move = await chooseComputerMove(pool, '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', { level: 1, rng: makeRng('x') });
    assert.equal(move, null);
  } finally {
    await pool.dispose();
  }
});

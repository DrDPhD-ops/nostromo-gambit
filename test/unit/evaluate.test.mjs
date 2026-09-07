import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInfoLine,
  parseEvalOutput,
  toWhitePov,
  flipPov,
  mateToCp,
  scoreToCp,
  winProbability,
  formatScore,
  createCurve,
  feedCurve,
  scoreAt,
  depthSpread,
  commonDepth,
  MATE_CP_THRESHOLD,
} from '../../src/engine/evaluate.mjs';

test('разбирает обычную строку info', () => {
  const p = parseInfoLine(
    'info depth 20 seldepth 30 multipv 1 score cp -24 wdl 120 700 180 nodes 449871 nps 1200000 time 374 pv d2d4 d7d5 c2c4',
  );
  assert.equal(p.depth, 20);
  assert.equal(p.seldepth, 30);
  assert.equal(p.multipv, 1);
  assert.deepEqual(p.score, { kind: 'cp', value: -24 });
  assert.equal(p.nodes, 449871);
  assert.deepEqual(p.wdl, { w: 120, d: 700, l: 180 });
  assert.deepEqual(p.pv, ['d2d4', 'd7d5', 'c2c4']);
});

test('разбирает матовые оценки в обе стороны', () => {
  assert.deepEqual(parseInfoLine('info depth 12 score mate 3 nodes 100 pv a1a2').score, { kind: 'mate', value: 3 });
  assert.deepEqual(parseInfoLine('info depth 12 score mate -2 nodes 100 pv a1a2').score, { kind: 'mate', value: -2 });
});

test('строки с границей окна поиска игнорируются', () => {
  assert.equal(parseInfoLine('info depth 9 score cp 333 upperbound nodes 12043 pv e2e4'), null);
  assert.equal(parseInfoLine('info depth 9 score cp -333 lowerbound nodes 12043 pv e2e4'), null);
});

test('строки без оценки или без глубины не проходят', () => {
  assert.equal(parseInfoLine('info string NNUE evaluation using nn-1234.nnue'), null);
  assert.equal(parseInfoLine('info depth 5 nodes 100 pv e2e4'), null);
  assert.equal(parseInfoLine('info score cp 10 nodes 100 pv e2e4'), null);
  assert.equal(parseInfoLine('bestmove e2e4'), null);
  assert.equal(parseInfoLine(null), null);
});

test('нормализация POV: score cp относится к стороне, которая ходит', () => {
  const s = { kind: 'cp', value: 24 };
  assert.deepEqual(toWhitePov(s, 'w'), { kind: 'cp', value: 24 });
  assert.deepEqual(toWhitePov(s, 'b'), { kind: 'cp', value: -24 });
  // операция обратна самой себе
  assert.deepEqual(flipPov(flipPov(s)), s);
});

test('mate -> cp монотонно и насыщается', () => {
  assert.ok(mateToCp(1) > mateToCp(5), 'мат в 1 лучше мата в 5');
  assert.ok(mateToCp(5) > 2000, 'любой мат весомее обычного перевеса в 20 пешек');
  assert.ok(mateToCp(-1) < mateToCp(-5), 'получить мат в 1 хуже, чем в 5');
  assert.ok(Math.abs(mateToCp(300)) > MATE_CP_THRESHOLD, 'насыщение не роняет мат ниже порога');
  assert.equal(mateToCp(200), mateToCp(300), 'дальше 200 ходов разницы нет');
});

test('scoreToCp сводит оба класса к одной шкале', () => {
  assert.equal(scoreToCp({ kind: 'cp', value: -137 }), -137);
  assert.equal(scoreToCp({ kind: 'mate', value: 2 }), mateToCp(2));
  assert.equal(scoreToCp(null), null);
});

test('вероятность победы симметрична и монотонна', () => {
  for (const cp of [0, 15, 80, 300, 1200]) {
    assert.ok(Math.abs(winProbability(cp) + winProbability(-cp) - 1) < 1e-9, `нарушена симметрия при ${cp}`);
  }
  assert.equal(winProbability(0), 0.5);
  assert.ok(winProbability(100) > winProbability(50));
  assert.equal(winProbability(MATE_CP_THRESHOLD + 1), 1);
  assert.equal(winProbability(-MATE_CP_THRESHOLD - 1), 0);
  // ±100 сп должны заметно двигать шкалу, иначе визуализация бесполезна
  assert.ok(winProbability(100) - 0.5 > 0.05, 'сотня сантипешек обязана быть видна на шкале');
});

test('форматирование оценки для человека', () => {
  assert.equal(formatScore({ kind: 'cp', value: 135 }), '+1.35');
  assert.equal(formatScore({ kind: 'cp', value: -40 }), '-0.40');
  assert.equal(formatScore({ kind: 'mate', value: 4 }), 'M4');
  assert.equal(formatScore({ kind: 'mate', value: -2 }), '-M2');
  assert.equal(formatScore(null), '—');
});

test('разбор вывода команды eval (всегда от лица белых)', () => {
  const text = [
    'NNUE derived piece values:',
    'NNUE network contributions (White to move)',
    'Final evaluation       +0.34 (white side) [with scaled NNUE, optimism, ...]',
  ].join('\n');
  assert.equal(parseEvalOutput(text), 34);
  assert.equal(parseEvalOutput('Final evaluation       -1.20 (white side)'), -120);
  assert.equal(parseEvalOutput('Final evaluation: none (in check)'), null, 'под шахом статической оценки нет');
  assert.equal(parseEvalOutput('ничего похожего'), null);
});

test('кривая: последняя строка на глубине побеждает, оценка сглаживается', () => {
  const c = createCurve();
  feedCurve(c, parseInfoLine('info depth 10 score cp 40 nodes 1 pv e2e4'), 'w');
  feedCurve(c, parseInfoLine('info depth 11 score cp 60 nodes 2 pv e2e4'), 'w');
  feedCurve(c, parseInfoLine('info depth 11 score cp 50 nodes 3 pv d2d4'), 'w');
  assert.equal(c.maxDepth, 11);
  assert.deepEqual(scoreAt(c, 11), { kind: 'cp', value: 45 }, 'среднее из 50 и 40');
  assert.deepEqual(c.pv, ['d2d4']);
});

test('кривая переворачивает оценку, когда ходят чёрные', () => {
  const c = createCurve();
  feedCurve(c, parseInfoLine('info depth 8 score cp 30 nodes 1 pv e7e5'), 'b');
  assert.deepEqual(scoreAt(c, 8), { kind: 'cp', value: -30 });
});

test('матовая оценка не усредняется с обычной', () => {
  const c = createCurve();
  feedCurve(c, parseInfoLine('info depth 9 score cp 500 nodes 1 pv a1a2'), 'w');
  feedCurve(c, parseInfoLine('info depth 10 score mate 3 nodes 2 pv a1a2'), 'w');
  assert.deepEqual(scoreAt(c, 10), { kind: 'mate', value: 3 });
});

test('разброс по глубине измеряет остроту позиции', () => {
  const quiet = createCurve();
  for (const [d, cp] of [[8, 20], [9, 22], [10, 21]]) {
    feedCurve(quiet, parseInfoLine(`info depth ${d} score cp ${cp} nodes 1 pv e2e4`), 'w');
  }
  const sharp = createCurve();
  for (const [d, cp] of [[8, -100], [9, 150], [10, 40]]) {
    feedCurve(sharp, parseInfoLine(`info depth ${d} score cp ${cp} nodes 1 pv e2e4`), 'w');
  }
  assert.ok(depthSpread(quiet, 10) <= 2);
  assert.ok(depthSpread(sharp, 10) >= 200);
  assert.ok(depthSpread(sharp, 10) > depthSpread(quiet, 10));
});

test('общая глубина — минимум по кривым, и ноль если хоть одна пуста', () => {
  const a = createCurve();
  const b = createCurve();
  feedCurve(a, parseInfoLine('info depth 14 score cp 0 nodes 1 pv e2e4'), 'w');
  feedCurve(b, parseInfoLine('info depth 11 score cp 0 nodes 1 pv e2e4'), 'w');
  assert.equal(commonDepth([a, b]), 11);
  assert.equal(commonDepth([a, createCurve()]), 0);
});

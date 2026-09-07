import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFen,
  formatFen,
  squareName,
  squareIndex,
  rankOf,
  mirrorSquare,
  boardToArray,
  arrayToBoard,
  applyDrop,
  normalizeForComparison,
  emptySquares,
  countMaterial,
  materialBalance,
  freeSlots,
  canAddPiece,
  promotionDebt,
  checkLimits,
  hasPawnOnBackRank,
  fenProblems,
} from '../../src/game/fen.mjs';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MID = 'r4rk1/pp3ppp/2n5/2pp4/8/2P1PN2/PP3PPP/R4RK1 w - - 0 18';

test('координаты полей туда и обратно', () => {
  assert.equal(squareName(0), 'a8');
  assert.equal(squareName(7), 'h8');
  assert.equal(squareName(56), 'a1');
  assert.equal(squareName(63), 'h1');
  for (const name of ['a1', 'e4', 'h8', 'd5']) {
    assert.equal(squareName(squareIndex(name)), name);
  }
  assert.equal(rankOf(squareIndex('e4')), 4);
  assert.equal(rankOf(squareIndex('a1')), 1);
});

test('зеркало по горизонтали сохраняет вертикаль', () => {
  assert.equal(squareName(mirrorSquare(squareIndex('e2'))), 'e7');
  assert.equal(squareName(mirrorSquare(squareIndex('a1'))), 'a8');
  assert.equal(squareName(mirrorSquare(squareIndex('d4'))), 'd5');
});

test('расстановка переживает разбор и пересборку', () => {
  for (const fen of [START, MID, '8/5pk1/6p1/7p/7P/5PK1/6P1/8 w - - 0 40']) {
    const board = parseFen(fen).board;
    assert.equal(arrayToBoard(boardToArray(board)), board);
  }
});

test('счётчик 50 ходов обнуляется при сравнении — иначе оценка систематически смещена', () => {
  const busy = '8/5pk1/6p1/7p/7P/5PK1/6P1/8 w - - 84 90';
  const norm = normalizeForComparison(busy);
  assert.equal(parseFen(norm).halfmove, 0);
  // Всё остальное обязано остаться нетронутым.
  const a = parseFen(busy);
  const b = parseFen(norm);
  assert.equal(a.board, b.board);
  assert.equal(a.turn, b.turn);
  assert.equal(a.castling, b.castling);
  assert.equal(a.fullmove, b.fullmove);
});

test('десант копирует права рокировки дословно и гасит взятие на проходе', () => {
  const fen = 'r3k2r/pppppppp/8/8/4P3/8/PPPP1PPP/R3K2R b KQkq e3 5 12';
  const after = applyDrop(fen, [{ square: squareIndex('d5'), piece: 'n' }]);
  const p = parseFen(after);
  assert.equal(p.castling, 'KQkq', 'права рокировки десант не трогает');
  assert.equal(p.ep, '-', 'право взятия на проходе теряется: между ходами вклинилось событие');
  assert.equal(p.halfmove, 0, 'прибытие материала — это прогресс');
  assert.equal(p.fullmove, 12, 'номер хода не меняется');
  assert.equal(p.turn, 'b', 'очередь хода не меняется');
});

test('десант на поле рокировки не отнимает прав', () => {
  const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
  const after = applyDrop(fen, [{ square: squareIndex('b1'), piece: 'N' }]);
  assert.equal(parseFen(after).castling, 'KQkq');
});

test('десант на занятое поле — ошибка, а не тихая перезапись', () => {
  assert.throws(() => applyDrop(START, [{ square: squareIndex('e2'), piece: 'N' }]), /занятое поле/);
});

test('свободные слоты, а не пустые поля, ограничивают десант', () => {
  assert.equal(emptySquares(START).length, 32, 'в начальной позиции 32 пустых поля');
  assert.equal(freeSlots(START), 0, 'и при этом ни одного свободного слота');
  assert.equal(countMaterial(START).total, 32);
  assert.equal(freeSlots(MID), 32 - countMaterial(MID).total);
});

test('материальный баланс считается от лица белых', () => {
  assert.equal(materialBalance(START), 0);
  assert.ok(materialBalance('4k3/8/8/8/8/8/8/Q3K3 w - - 0 1') > 800);
  assert.ok(materialBalance('q3k3/8/8/8/8/8/8/4K3 w - - 0 1') < -800);
});

test('долг превращений: сверхкомплектная фигура требует пешки', () => {
  assert.equal(promotionDebt({ p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 }), 0);
  assert.equal(promotionDebt({ p: 8, n: 2, b: 2, r: 3, q: 1, k: 1 }), 1);
  assert.equal(promotionDebt({ p: 6, n: 2, b: 2, r: 2, q: 3, k: 1 }), 2);
  assert.equal(promotionDebt({ p: 0, n: 4, b: 2, r: 2, q: 1, k: 1 }), 2);
});

test('позиции, роняющие Stockfish, отсекаются проверкой пределов', () => {
  // Все три проверены на живом движке: он завершается с кодом 1.
  const crashers = [
    ['8 пешек и 3 ладьи', '4k3/8/8/8/3PP3/5R2/PPP2PPP/R3K2R w - - 0 10'],
    ['8 пешек и 2 ферзя', '4k3/8/8/8/8/1Q6/PPPPPPPP/Q2K4 w - - 0 1'],
    ['33 фигуры', 'rnbqkbnr/pppppppp/8/8/8/N7/PPPPPPPP/RNBQKBNR w KQkq - 0 1'],
  ];
  for (const [label, fen] of crashers) {
    assert.ok(checkLimits(fen).length > 0, `${label} обязана быть отвергнута`);
  }
  // А законные позиции — проходить.
  for (const fen of [START, MID, '4k3/8/8/8/3PP3/5R2/PPP2PP1/R3K2R w - - 0 10']) {
    assert.deepEqual(checkLimits(fen), [], `позиция ${fen} законна`);
  }
});

test('canAddPiece учитывает и общий предел, и долг превращений', () => {
  assert.equal(canAddPiece(START, 'w', 'n'), false, 'на полной доске добавить нечего');
  assert.equal(canAddPiece(MID, 'w', 'n'), true);
  assert.equal(canAddPiece(MID, 'w', 'k'), false, 'король никогда');
  // 8 пешек уже есть: третья ладья потребовала бы девятой.
  const eightPawns = '4k3/8/8/8/8/8/PPPPPPPP/R3K2R w - - 0 1';
  assert.equal(canAddPiece(eightPawns, 'w', 'r'), false);
  assert.equal(canAddPiece(eightPawns, 'w', 'n'), true, 'конь в комплекте — можно');
});

test('пешка на крайней горизонтали ловится отдельно', () => {
  assert.equal(hasPawnOnBackRank(START), false);
  assert.equal(hasPawnOnBackRank('P3k3/8/8/8/8/8/8/4K3 w - - 0 1'), true);
  assert.ok(fenProblems('P3k3/8/8/8/8/8/8/4K3 w - - 0 1').some((p) => p.includes('пешка')));
});

test('formatFen собирает ровно то, что разобрал parseFen', () => {
  for (const fen of [START, MID, 'r3k2r/pppppppp/8/8/4P3/8/PPPP1PPP/R3K2R b KQkq e3 5 12']) {
    assert.equal(formatFen(parseFen(fen)), fen);
  }
});

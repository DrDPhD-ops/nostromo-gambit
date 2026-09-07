import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, START_FEN } from '../../src/game/game.mjs';
import { applyDrop as applyDropToFen, squareIndex } from '../../src/game/fen.mjs';

const FOOLS_MATE_SETUP = [
  { from: 'f2', to: 'f3' },
  { from: 'e7', to: 'e5' },
  { from: 'g2', to: 'g4' },
  { from: 'd8', to: 'h4' },
];

function play(game, moves) {
  for (const m of moves) {
    const r = game.move(m);
    assert.equal(r.ok, true, `ход ${m.from}${m.to} должен пройти: ${r.message || ''}`);
  }
  return game;
}

test('новая партия начинается со стандартной позиции', () => {
  const g = new Game();
  assert.equal(g.fen, START_FEN);
  assert.equal(g.version, 0);
  assert.equal(g.turn, 'w');
  assert.equal(g.gameOver, null);
  assert.equal(g.snapshot().board.length, 32);
  assert.equal(g.snapshot().freeSlots, 0, 'в начальной позиции свободных слотов нет');
});

test('легальный ход принимается, нелегальный отвергается', () => {
  const g = new Game();
  assert.equal(g.move({ from: 'e2', to: 'e4' }).ok, true);
  assert.equal(g.version, 1);
  const bad = g.move({ from: 'e2', to: 'e5' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'ILLEGAL_MOVE');
  assert.equal(g.version, 1, 'отвергнутый ход не должен двигать версию');
});

test('превращение без указания фигуры требует выбора', () => {
  // Короли разведены: на e1/e2 они стояли бы вплотную, а такой позиции не бывает.
  const g = new Game({ fen: '8/4P3/8/8/8/8/8/4K2k w - - 0 1' });
  const r = g.move({ from: 'e7', to: 'e8' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PROMOTION_REQUIRED');
  assert.equal(g.move({ from: 'e7', to: 'e8', promotion: 'q' }).ok, true);
  assert.equal(g.chess.get('e8').type, 'q');
});

test('счётчик авто-десанта считает полные ходы, а не полуходы', () => {
  const g = new Game({ settings: { autoDropEveryFullMoves: 2 } });
  assert.equal(g.movesUntilAutoDrop, 2);
  g.move({ from: 'e2', to: 'e4' });
  assert.equal(g.movesUntilAutoDrop, 2, 'после хода белых счётчик не двигается');
  g.move({ from: 'e7', to: 'e5' });
  assert.equal(g.movesUntilAutoDrop, 1, 'полный ход засчитан после хода чёрных');
  g.move({ from: 'g1', to: 'f3' });
  g.move({ from: 'b8', to: 'c6' });
  assert.equal(g.movesUntilAutoDrop, 0);
  assert.equal(g.autoDropDue, true);
});

test('мат определяется и закрывает партию', () => {
  const g = play(new Game(), FOOLS_MATE_SETUP);
  assert.ok(g.gameOver, 'после дурацкого мата партия должна быть окончена');
  assert.equal(g.gameOver.reason, 'checkmate');
  assert.equal(g.gameOver.winner, 'b');
  const after = g.move({ from: 'e1', to: 'e2' });
  assert.equal(after.ok, false);
  assert.equal(after.code, 'GAME_OVER');
});

test('пат и недостаток материала различаются', () => {
  const stalemate = new Game({ fen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1' });
  assert.equal(stalemate.gameOver.reason, 'stalemate');
  const bare = new Game({ fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1' });
  assert.equal(bare.gameOver.reason, 'insufficient_material');
});

test('идентификаторы фигур переезжают вместе с ходом, а не пересоздаются', () => {
  const g = new Game();
  const before = g.pieces.get('e2').id;
  g.move({ from: 'e2', to: 'e4' });
  assert.equal(g.pieces.has('e2'), false);
  assert.equal(g.pieces.get('e4').id, before, 'та же фигура должна сохранить идентификатор');
});

test('рокировка переносит и короля, и ладью', () => {
  const g = new Game({ fen: 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1' });
  const kingId = g.pieces.get('e1').id;
  const rookId = g.pieces.get('h1').id;
  assert.equal(g.move({ from: 'e1', to: 'g1' }).ok, true);
  assert.equal(g.pieces.get('g1').id, kingId);
  assert.equal(g.pieces.get('f1').id, rookId, 'ладья обязана сохранить идентификатор при рокировке');
  assert.equal(g.pieces.has('h1'), false);
});

test('взятие на проходе убирает пешку с поля, где её нет', () => {
  const g = new Game({ fen: 'rnbqkbnr/pp1ppppp/8/8/4pP2/8/PPPPP1PP/RNBQKBNR b KQkq f3 0 3' });
  assert.equal(g.pieces.has('f4'), true);
  assert.equal(g.move({ from: 'e4', to: 'f3' }).ok, true);
  assert.equal(g.pieces.has('f4'), false, 'побитая на проходе пешка должна исчезнуть');
  assert.equal(g.pieces.has('f3'), true);
});

test('отмена возвращает ровно предыдущую позицию', () => {
  const g = new Game();
  const start = g.fen;
  g.move({ from: 'e2', to: 'e4' });
  const afterOne = g.fen;
  g.move({ from: 'e7', to: 'e5' });
  assert.equal(g.undo().ok, true);
  assert.equal(g.fen, afterOne);
  assert.equal(g.undo().ok, true);
  assert.equal(g.fen, start);
  const nothing = g.undo();
  assert.equal(nothing.ok, false);
  assert.equal(nothing.code, 'NOTHING_TO_UNDO');
});

// ─────────────────────────────────────── десант



function makeDrop(fen, placements, extra = {}) {
  const after = applyDropToFen(
    fen,
    placements.map((p) => ({
      square: squareIndex(p.squareName),
      piece: p.color === 'w' ? p.type.toUpperCase() : p.type.toLowerCase(),
    })),
  );
  return {
    ok: true,
    fen: after,
    placements,
    package: { w: placements.filter((p) => p.color === 'w').map((p) => p.type), b: [], label: 'тест' },
    nominalDeltaCp: 0,
    evalBefore: 10,
    evalAfter: 12,
    delta: 2,
    targetDelta: 0,
    error: 2,
    toleranceUsed: 30,
    toleranceWidened: false,
    searchMs: 1,
    storyteller: 'bishop',
    dice: null,
    ...extra,
  };
}

test('десант не стирает журнал ходов — регрессия на поведение chess.js load()', () => {
  const g = new Game({ fen: 'r4rk1/pp3ppp/2n5/2pp4/8/2P1PN2/PP3PPP/R4RK1 w - - 0 18' });
  g.move({ from: 'f3', to: 'e5' });
  g.move({ from: 'c6', to: 'e5' });
  const sansBefore = g.moveLog.map((m) => m.san);
  assert.equal(sansBefore.length, 2);

  const drop = makeDrop(g.fen, [
    { squareName: 'd3', color: 'w', type: 'n' },
    { squareName: 'd6', color: 'b', type: 'n' },
  ]);
  assert.equal(g.applyDrop(drop).ok, true);

  assert.deepEqual(
    g.moveLog.map((m) => m.san),
    sansBefore,
    'после десанта журнал ходов обязан остаться прежним',
  );
  assert.equal(g.chess.get('d3').type, 'n');
  assert.equal(g.chess.get('d6').color, 'b');
});

test('отмена после десанта убирает фигуры и возвращает жетон', () => {
  const g = new Game({ fen: 'r4rk1/pp3ppp/2n5/2pp4/8/2P1PN2/PP3PPP/R4RK1 w - - 0 18' });
  const fenBefore = g.fen;
  g.spendDiceRoll('w');
  assert.equal(g.dice.w, 2);

  const drop = makeDrop(fenBefore, [{ squareName: 'd4', color: 'w', type: 'b' }], {
    dice: { d1: 3, d2: 4, sum: 7, spread: 1, side: 'w', budgetCp: 510, skewCp: 20 },
  });
  g.applyDrop(drop);
  assert.equal(g.dropLog.length, 1);
  assert.equal(g.chess.get('d4').type, 'b');

  assert.equal(g.undo().ok, true);
  assert.equal(g.fen, fenBefore, 'позиция обязана вернуться к состоянию до десанта');
  assert.equal(g.dropLog.length, 0);
  assert.equal(g.dice.w, 3, 'жетон обязан вернуться — иначе отмена дарит бросок');
});

test('десант обнуляет счётчик до автоматической высадки', () => {
  const g = new Game({
    fen: 'r4rk1/pp3ppp/2n5/2pp4/8/2P1PN2/PP3PPP/R4RK1 w - - 0 18',
    settings: { autoDropEveryFullMoves: 2 },
  });
  g.move({ from: 'a1', to: 'b1' });
  g.move({ from: 'a8', to: 'b8' });
  assert.equal(g.movesUntilAutoDrop, 1);
  g.applyDrop(makeDrop(g.fen, [{ squareName: 'd4', color: 'w', type: 'p' }]));
  assert.equal(g.movesUntilAutoDrop, 2, 'счётчик обязан перевзвестись');
});

test('снимок содержит всё, что нужно клиенту, и ничего лишнего', () => {
  const g = new Game();
  const s = g.snapshot();
  for (const key of ['version', 'fen', 'turn', 'board', 'legalMoves', 'dice', 'storyteller', 'freeSlots']) {
    assert.ok(key in s, `в снимке должно быть поле ${key}`);
  }
  assert.equal(Object.keys(s.legalMoves).length, 10, 'в начальной позиции ходят 8 пешек и 2 коня');
  assert.equal(s.storyteller.id, 'bishop');
});

test('PGN включает десанты как комментарии', () => {
  const g = new Game({ fen: 'r4rk1/pp3ppp/2n5/2pp4/8/2P1PN2/PP3PPP/R4RK1 w - - 0 18' });
  g.move({ from: 'f3', to: 'e5' });
  g.applyDrop(makeDrop(g.fen, [{ squareName: 'd3', color: 'w', type: 'n' }]));
  g.move({ from: 'c6', to: 'e5' });
  const pgn = g.toPgn();
  assert.ok(pgn.includes('ДЕСАНТ #1'), 'десант должен попасть в PGN');
  assert.ok(pgn.includes('Nxe5'), 'ходы должны остаться на месте');
});

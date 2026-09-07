import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import {
  legalSquaresFor,
  validatePlacement,
  deferReason,
  captureGainForEnemy,
  enginePositionProblem,
} from '../../src/game/dropRules.mjs';
import { squareIndex, squareName, rankOf } from '../../src/game/fen.mjs';

const MID = 'r4rk1/pp3ppp/2n5/2pp4/8/2P1PN2/PP3PPP/R4RK1 w - - 0 18';
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const place = (sq, color, type) => [{ square: squareIndex(sq), color, type }];

test('поля под десант — только пустые', () => {
  const squares = legalSquaresFor(MID, 'w', 'n');
  const chess = new Chess(MID);
  for (const idx of squares) {
    assert.equal(chess.get(squareName(idx)), undefined, `${squareName(idx)} обязано быть пустым`);
  }
});

test('пешки не ставятся на первую, восьмую и предпоследнюю горизонтали', () => {
  for (const idx of legalSquaresFor(MID, 'w', 'p')) {
    const r = rankOf(idx);
    assert.ok(r >= 2 && r <= 6, `белая пешка на горизонтали ${r} недопустима`);
  }
  for (const idx of legalSquaresFor(MID, 'b', 'p')) {
    const r = rankOf(idx);
    assert.ok(r >= 3 && r <= 7, `чёрная пешка на горизонтали ${r} недопустима`);
  }
  // С разрешением предпоследняя горизонталь открывается.
  const relaxed = legalSquaresFor(MID, 'w', 'p', { allowNearPromotion: true });
  assert.ok(relaxed.some((idx) => rankOf(idx) === 7));
});

test('король не десантируется никогда', () => {
  assert.deepEqual(legalSquaresFor(MID, 'w', 'k'), []);
  const r = validatePlacement(MID, place('d4', 'w', 'k'));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('корол')));
});

test('десант не имеет права объявлять шах', () => {
  // Ладья на d8 по вертикали бьёт короля g8? Нет. Возьмём поле, откуда бьёт точно.
  const fen = '6k1/8/8/8/8/8/8/4K3 w - - 0 1';
  const check = validatePlacement(fen, place('g5', 'w', 'r'), { forbidCheck: true });
  assert.equal(check.ok, false, 'ладья на g5 бьёт короля g8 — такой десант запрещён');
  assert.ok(check.problems.some((p) => p.includes('шах') || p.includes('атакует')));
});

test('нельзя оставить под шахом сторону, которая НЕ ходит', () => {
  // Ход белых; ставим белую ладью так, чтобы она била чёрного короля.
  const fen = '6k1/8/8/8/8/8/8/4K3 w - - 0 1';
  const r = validatePlacement(fen, place('g4', 'w', 'r'), { forbidCheck: false });
  assert.equal(r.ok, false);
  assert.ok(
    r.problems.some((p) => p.includes('не к ходу') || p.includes('атакует')),
    `ожидали жалобу на нелегальную позицию, получили: ${r.problems.join('; ')}`,
  );
});

test('десант не превращает шах в мат перекрытием отхода', () => {
  // Король h8 в углу, ход чёрных; ладьи g-линии и 7-й горизонтали не хватает.
  const fen = '7k/8/8/8/8/8/6R1/4K3 b - - 0 1';
  const before = new Chess(fen);
  assert.ok(before.moves().length > 0, 'до десанта ходы есть');
  // Ставим белую ладью на h-линию — это шах, значит десант обязан быть отвергнут.
  const r = validatePlacement(fen, place('h5', 'w', 'r'));
  assert.equal(r.ok, false);
});

test('SEE-гейт: подвешенную фигуру десантировать нельзя', () => {
  // Чёрная пешка на d5 бьёт c4 и e4; ставим туда белого коня без защиты.
  const fen = '4k3/8/8/3p4/8/8/8/4K3 w - - 0 1';
  const hanging = validatePlacement(fen, place('c4', 'w', 'n'));
  assert.equal(hanging.ok, false, 'конь под боем пешки и без защиты — это подарок');
  assert.ok(hanging.problems.some((p) => p.includes('висит')));
});

test('размен на поле считается по классической схеме', () => {
  // Конь на c4 под боем пешки d5, без защитников: соперник выигрывает коня.
  const chess = new Chess('4k3/8/8/3p4/2N5/8/8/4K3 b - - 0 1');
  assert.ok(captureGainForEnemy(chess, 'c4', 'w') > 200, 'потеря коня за пешку должна быть видна');
  // Конь под боем ЛАДЬИ и под защитой пешки: бить невыгодно уже сопернику.
  // (Под боем пешки конь плох при любой защите — размен пешки на коня всё равно выгоден,
  // и SEE обязан это показывать.)
  const guarded = new Chess('2r1k3/8/8/8/2N5/1P6/8/4K3 b - - 0 1');
  assert.ok(captureGainForEnemy(guarded, 'c4', 'w') <= 0, 'ладья за коня с отдачей — не подарок');
});

test('пределы доски соблюдаются и в совместной расстановке', () => {
  const eightPawns = '4k3/8/8/8/8/8/PPPPPPPP/R3K2R w - - 0 1';
  const r = validatePlacement(eightPawns, place('d4', 'w', 'r'));
  assert.equal(r.ok, false, 'третья ладья при восьми пешках недостижима');
});

test('отказ от десанта: полный трюм, шах, конец партии', () => {
  assert.match(deferReason(START), /трюм полон/i);
  // Шах, но не мат: королю есть куда уйти.
  assert.match(deferReason('4k3/8/8/8/7q/8/8/4K3 w - - 0 1'), /шах/i);
  assert.match(deferReason('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'), /окончена/i);
  assert.equal(deferReason(MID), null, 'в рабочей позиции отказа быть не должно');
});

test('нелегальную для движка позицию ловим до отправки', () => {
  // Белый ферзь по открытой вертикали бьёт чёрного короля, а ход белых.
  assert.match(enginePositionProblem('8/8/4k3/8/8/3K4/4Q3/5r2 w - - 0 55'), /не к ходу/);
  assert.equal(enginePositionProblem(MID), null);
  assert.match(enginePositionProblem('rnbqkbnr/pppppppp/8/8/8/N7/PPPPPPPP/RNBQKBNR w KQkq - 0 1'), /33/);
});

test('корректный десант проходит все проверки и даёт валидный FEN', () => {
  // Поля выбраны так, чтобы фигуры никем не били: d4 и d6 здесь под боем пешек,
  // и SEE-гейт справедливо их отвергает.
  const r = validatePlacement(MID, [
    { square: squareIndex('h4'), color: 'w', type: 'n' },
    { square: squareIndex('a5'), color: 'b', type: 'n' },
  ]);
  assert.equal(r.ok, true, `ожидали успех, получили: ${r.problems.join('; ')}`);
  const chess = new Chess(r.fen);
  assert.equal(chess.get('h4').type, 'n');
  assert.equal(chess.get('a5').color, 'b');
  assert.ok(chess.moves().length > 0);
});

test('настройка «разрешить шах» действительно что-то меняет', () => {
  // Белая ладья на g5 бьёт чёрного короля g8. Ход ЧЁРНЫХ — значит это шах
  // стороне к ходу, то есть ровно тот случай, которым управляет настройка.
  const fen = '6k1/8/8/8/8/8/8/4K3 b - - 0 1';
  const placement = place('g5', 'w', 'r');

  const forbidden = validatePlacement(fen, placement, { forbidCheck: true });
  assert.equal(forbidden.ok, false, 'при запрете шаха расстановка обязана отвергаться');
  assert.ok(forbidden.problems.some((p) => p.includes('шах')));

  const allowed = validatePlacement(fen, placement, { forbidCheck: false });
  assert.equal(
    allowed.ok,
    true,
    `при разрешённом шахе расстановка обязана проходить, получили: ${allowed.problems.join('; ')}`,
  );
});

test('шах стороне НЕ к ходу запрещён независимо от настройки', () => {
  // Тот же десант, но ходят белые: теперь под боем оказывается король чёрных,
  // которые не ходят, а такой позиции не существует ни при каких настройках.
  const fen = '6k1/8/8/8/8/8/8/4K3 w - - 0 1';
  for (const forbidCheck of [true, false]) {
    const r = validatePlacement(fen, place('g5', 'w', 'r'), { forbidCheck });
    assert.equal(r.ok, false, `forbidCheck=${forbidCheck}: позиция нелегальна в любом случае`);
  }
});

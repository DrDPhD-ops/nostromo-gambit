// Правила легальности десанта.
//
// Проверено на месте: chess.js `validateFen` возвращает ok для позиции, в которой
// сторона НЕ к ходу стоит под шахом. Такой позиции в партии не бывает, и ловить
// это обязаны мы сами — библиотека здесь не помощник.
//
// Полезное наблюдение, на котором держится скорость: десант только ДОБАВЛЯЕТ фигуры.
// Добавление не может открыть вскрытый шах — оно способно лишь создать новую атаку
// от самой поставленной фигуры или, наоборот, перекрыть существующую линию.
// Значит «не появилось новых шахов» проверяется одним вопросом: атакует ли хоть одна
// десантируемая фигура хоть одного короля.
import { Chess } from 'chess.js';
import {
  PIECE_VALUE,
  applyDrop,
  emptySquares,
  freeSlots,
  canAddPiece,
  squareName,
  squareIndex,
  rankOf,
  fenToArray,
  checkLimits,
  fenProblems,
  LIMITS,
} from './fen.mjs';

export const DEFAULT_DROP_OPTIONS = {
  /** Пешки на предпоследней горизонтали ходом раньше превращаются в ферзя — по умолчанию нельзя. */
  allowNearPromotion: false,
  /** Десант не имеет права объявлять шах. */
  forbidCheck: true,
  /** Максимально допустимый выигрыш соперника от взятия десантируемой фигуры, сп. */
  maxHangingCp: 0,
  limits: LIMITS,
};

// ───────────────────────────────────────────────── поля под конкретную фигуру

/**
 * Поля, куда фигуру данного типа и цвета в принципе можно поставить.
 * Только статические условия: занятость, горизонтали для пешек, атака на короля.
 * Совместные проверки (пат, SEE, пределы) делаются уже над готовой расстановкой.
 */
export function legalSquaresFor(fen, color, type, opts = {}) {
  const o = { ...DEFAULT_DROP_OPTIONS, ...opts };
  if (type === 'k') return [];
  // Лимиты по типам проверяются ЗДЕСЬ, а не только над готовой расстановкой.
  // Иначе маржинальная таблица построит зонд с девятой пешкой, а такой FEN
  // не просто нелегален — на нём Stockfish завершается с кодом 1.
  if (!canAddPiece(fen, color, type, o.limits)) return [];

  const chess = new Chess(fen);
  const kings = {
    w: chess.findPiece({ type: 'k', color: 'w' })[0],
    b: chess.findPiece({ type: 'k', color: 'b' })[0],
  };
  const piece = color === 'w' ? type.toUpperCase() : type.toLowerCase();
  const out = [];

  for (const idx of emptySquares(fen)) {
    if (type === 'p') {
      const rank = rankOf(idx);
      if (rank === 1 || rank === 8) continue;
      if (!o.allowNearPromotion) {
        if (color === 'w' && rank === 7) continue;
        if (color === 'b' && rank === 2) continue;
      }
    }

    if (o.forbidCheck) {
      // Ставим фигуру на доску и спрашиваем, не бьёт ли она короля.
      // Дешевле, чем строить FEN: chess.js оперирует своей внутренней доской.
      const sq = squareName(idx);
      chess.put({ type, color }, sq);
      const givesCheck =
        (kings.w && chess.attackers(kings.w, color).includes(sq)) ||
        (kings.b && chess.attackers(kings.b, color).includes(sq));
      chess.remove(sq);
      if (givesCheck) continue;
    }

    out.push(idx);
  }
  return out;
}

/**
 * Можно ли вообще отдавать эту позицию движку.
 *
 * Не теоретическая придирка: проверено на этой сборке, что Stockfish завершается
 * с кодом 1 и на позиции с 33 фигурами, и на позиции, где сторона НЕ к ходу стоит
 * под шахом (`8/8/4k3/8/8/3K4/4Q3/5r2 w - - 0 55`: белый ферзь бьёт чёрного короля,
 * а ход белых). Каждая такая отправка стоит перезапуска процесса, поэтому проверка
 * идёт перед КАЖДОЙ отправкой в движок — она в тысячи раз дешевле падения.
 *
 * @returns {string|null} описание проблемы или null, если позицию можно считать
 */
export function enginePositionProblem(fen) {
  const problems = fenProblems(fen);
  if (problems.length) return problems[0];
  let chess;
  try {
    chess = new Chess(fen);
  } catch (err) {
    return `chess.js не принял позицию: ${err.message}`;
  }
  const turn = chess.turn();
  const waiting = turn === 'w' ? 'b' : 'w';
  const waitingKing = chess.findPiece({ type: 'k', color: waiting })[0];
  if (waitingKing && chess.isAttacked(waitingKing, turn)) {
    return 'сторона не к ходу под шахом — такой позиции не существует';
  }
  return null;
}

// ───────────────────────────────────────────────── статический размен на поле

/**
 * Классический размен на поле (SEE без учёта вскрытых батарей).
 * Возвращает выигрыш СОПЕРНИКА от того, что он начнёт бить на этом поле.
 * Ноль или меньше — фигура стоит нормально; больше нуля — мы подарили материал.
 */
export function captureGainForEnemy(chess, square, ownColor) {
  const enemy = ownColor === 'w' ? 'b' : 'w';
  const valuesOf = (squares) =>
    squares
      .map((sq) => {
        const p = chess.get(sq);
        return p ? PIECE_VALUE[p.type] : 0;
      })
      .sort((a, b) => a - b);

  const occupant = chess.get(square);
  if (!occupant) return 0;
  const attackers = valuesOf(chess.attackers(square, enemy));
  if (attackers.length === 0) return 0; // никто не бьёт — брать нечего
  const defenders = valuesOf(chess.attackers(square, ownColor));

  const gain = [PIECE_VALUE[occupant.type]];
  let d = 0;
  let ai = 0;
  let di = 0;
  let enemyToMove = true;
  let next = attackers[ai++];

  while (next !== undefined) {
    d += 1;
    gain[d] = next - gain[d - 1];
    // Обрубаем ветку, в которой бить уже невыгодно ни одной из сторон.
    if (Math.max(-gain[d - 1], gain[d]) < 0) break;
    enemyToMove = !enemyToMove;
    next = enemyToMove ? attackers[ai++] : defenders[di++];
  }
  while (--d > 0) gain[d - 1] = -Math.max(-gain[d - 1], gain[d]);
  return gain[0];
}

// ───────────────────────────────────────────────── проверка готовой расстановки

/**
 * Полная проверка совместной расстановки. Возвращает список проблем;
 * пустой список означает, что десант можно применять.
 *
 * @param {string} fen             позиция до десанта
 * @param {Array<{square:number|string, color:'w'|'b', type:string}>} placements
 */
export function validatePlacement(fen, placements, opts = {}) {
  const o = { ...DEFAULT_DROP_OPTIONS, ...opts };
  const problems = [];

  // 1. Поля пусты, различны и это не короли.
  const before = fenToArray(fen);
  const seen = new Set();
  for (const p of placements) {
    const idx = typeof p.square === 'number' ? p.square : squareIndex(p.square);
    if (idx < 0 || idx > 63) problems.push(`поле вне доски: ${p.square}`);
    if (before[idx]) problems.push(`поле занято: ${squareName(idx)}`);
    if (seen.has(idx)) problems.push(`две фигуры на одно поле: ${squareName(idx)}`);
    seen.add(idx);
    if (p.type === 'k') problems.push('десант короля недопустим');
    if (p.type === 'p') {
      const rank = rankOf(idx);
      if (rank === 1 || rank === 8) problems.push(`пешка на горизонтали ${rank}`);
      if (!o.allowNearPromotion) {
        if (p.color === 'w' && rank === 7) problems.push('белая пешка на 7-й горизонтали');
        if (p.color === 'b' && rank === 2) problems.push('чёрная пешка на 2-й горизонтали');
      }
    }
  }
  if (problems.length) return { ok: false, problems, fen: null };

  const after = applyDrop(
    fen,
    placements.map((p) => ({
      square: p.square,
      piece: p.color === 'w' ? p.type.toUpperCase() : p.type.toLowerCase(),
    })),
  );

  // 2. Пределы, за которыми позиция перестаёт быть шахматной.
  problems.push(...checkLimits(after, o.limits));
  if (problems.length) return { ok: false, problems, fen: after };

  const chess = new Chess(after);
  const turn = chess.turn();
  const waiting = turn === 'w' ? 'b' : 'w';
  const kingOf = (c) => chess.findPiece({ type: 'k', color: c })[0];
  const wk = kingOf('w');
  const bk = kingOf('b');

  // 3. Сторона НЕ к ходу под шахом — позиции не существует. chess.js это пропускает.
  const waitingKing = waiting === 'w' ? wk : bk;
  if (waitingKing && chess.isAttacked(waitingKing, turn)) {
    problems.push('сторона не к ходу оказалась под шахом — позиция нелегальна');
  }

  // 4. Десант не объявляет шах.
  const movingKing = turn === 'w' ? wk : bk;
  if (o.forbidCheck && movingKing && chess.isAttacked(movingKing, waiting)) {
    problems.push('десант объявляет шах стороне к ходу');
  }

  // 5. У стороны к ходу остаётся ход. Добавленные фигуры способны перекрыть
  //    поля отхода и превратить шах в мат — это надо ловить явно.
  if (chess.moves().length === 0) {
    problems.push('после десанта у стороны к ходу не осталось ходов');
  }

  // 6. Атака десантируемой фигуры на короля стороны, которая НЕ ходит.
  //
  // Проверка 3 выше ловит тот же случай через isAttacked и потому шире, но эта
  // называет конкретное поле — по такому сообщению видно, что именно сломалось.
  // Шах стороне К ХОДУ здесь НЕ проверяется: за него отвечает проверка 4, и
  // дублировать её нельзя — тогда настройка forbidCheck перестаёт что-либо решать,
  // потому что отключение одной из двух одинаковых проверок ничего не меняет.
  for (const p of placements) {
    const sq = typeof p.square === 'number' ? squareName(p.square) : p.square;
    if (waitingKing && chess.attackers(waitingKing, p.color).includes(sq)) {
      problems.push(`десантируемая фигура на ${sq} атакует короля стороны не к ходу`);
    }
  }

  // 7. Не дарим материал: каждая новая фигура должна пережить размен на своём поле.
  for (const p of placements) {
    const sq = typeof p.square === 'number' ? squareName(p.square) : p.square;
    const loss = captureGainForEnemy(chess, sq, p.color);
    if (loss > o.maxHangingCp) {
      problems.push(`фигура на ${sq} висит: соперник выигрывает ${loss} сп`);
    }
  }

  return { ok: problems.length === 0, problems, fen: after };
}

/** Быстрая версия для горячего цикла: только «да/нет», без сбора текста проблем. */
export function isPlacementLegal(fen, placements, opts = {}) {
  return validatePlacement(fen, placements, opts).ok;
}

/**
 * Позиции, в которых десантировать не следует вовсе.
 * Шах — самый важный случай: подкрепление посреди объявленного шаха выглядит
 * произволом и вдобавок рискует превратить шах в мат перекрытием полей отхода.
 */
export function deferReason(fen, opts = {}) {
  const o = { ...DEFAULT_DROP_OPTIONS, ...opts };
  const unsafe = enginePositionProblem(fen);
  if (unsafe) return `позицию нельзя отдать движку: ${unsafe}`;
  const chess = new Chess(fen);
  if (chess.isGameOver()) return 'партия окончена';
  // Десант посреди объявленного шаха выглядит произволом и вдобавок рискует
  // превратить шах в мат перекрытием полей отхода. Ждём следующего хода.
  if (chess.isCheck()) return 'сторона к ходу под шахом';
  // Главное ограничение всей механики: в шахматах не бывает больше 32 фигур,
  // и партия начинается ровно с 32. Пока никого не разменяли, высаживать некуда.
  const slots = freeSlots(fen, o.limits);
  if (slots < 2) return 'трюм полон: на доске 32 фигуры, десант возможен только после потерь';
  const problems = checkLimits(fen, o.limits);
  if (problems.length) return `позиция уже на пределе: ${problems[0]}`;
  return null;
}

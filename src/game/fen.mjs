// Работа с FEN напрямую, без посредников.
//
// Почему не chess.js `put()`: он пересчитывает права рокировки по своим правилам,
// и десант на a1/h1 может молча их отнять. Десант обязан менять ровно то, что
// он меняет, — расстановку фигур, — и ничего больше.
//
// Индексация: 0 = a8, 7 = h8, 56 = a1, 63 = h1 (порядок самого FEN).

export const FILES = 'abcdefgh';
export const PIECE_TYPES = ['p', 'n', 'b', 'r', 'q', 'k'];

/** Номинальная стоимость для гроссбуха и подбора пакетов. Не оценка движка. */
export const PIECE_VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

export function squareName(index) {
  return `${FILES[index % 8]}${8 - (index >> 3)}`;
}

export function squareIndex(name) {
  const f = FILES.indexOf(name[0]);
  const r = Number(name[1]);
  if (f < 0 || !Number.isFinite(r) || r < 1 || r > 8) return -1;
  return (8 - r) * 8 + f;
}

export function fileOf(index) {
  return index % 8;
}

/** Горизонталь в человеческой нумерации: 1 внизу, 8 наверху. */
export function rankOf(index) {
  return 8 - (index >> 3);
}

/** Зеркало по горизонтали: тот же файл, горизонталь 9−r. Основа запасного десанта. */
export function mirrorSquare(index) {
  return (rankOf(index) - 1) * 8 + fileOf(index);
}

export function colorOfPiece(ch) {
  return ch === ch.toUpperCase() ? 'w' : 'b';
}

// ───────────────────────────────────────────────── разбор и сборка

export function parseFen(fen) {
  const parts = String(fen).trim().split(/\s+/);
  if (parts.length < 4) throw new Error(`Некорректный FEN: ${fen}`);
  return {
    board: parts[0],
    turn: parts[1] === 'b' ? 'b' : 'w',
    castling: parts[2] || '-',
    ep: parts[3] || '-',
    halfmove: Number.isFinite(Number(parts[4])) ? Number(parts[4]) : 0,
    fullmove: Number.isFinite(Number(parts[5])) ? Number(parts[5]) : 1,
  };
}

export function formatFen(p) {
  return [p.board, p.turn, p.castling || '-', p.ep || '-', p.halfmove ?? 0, p.fullmove ?? 1].join(' ');
}

/** Строка расстановки -> массив из 64 символов, где пустое поле — null. */
export function boardToArray(boardField) {
  const squares = new Array(64).fill(null);
  let i = 0;
  for (const ch of boardField) {
    if (ch === '/') continue;
    if (ch >= '1' && ch <= '8') {
      i += Number(ch);
      continue;
    }
    if (i < 64) squares[i] = ch;
    i += 1;
  }
  return squares;
}

export function arrayToBoard(squares) {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let row = '';
    let gap = 0;
    for (let f = 0; f < 8; f++) {
      const piece = squares[r * 8 + f];
      if (piece) {
        if (gap) {
          row += gap;
          gap = 0;
        }
        row += piece;
      } else {
        gap += 1;
      }
    }
    if (gap) row += gap;
    rows.push(row);
  }
  return rows.join('/');
}

export function fenToArray(fen) {
  return boardToArray(parseFen(fen).board);
}

// ───────────────────────────────────────────────── ключевые преобразования

/**
 * Приведение к виду, пригодному для СРАВНЕНИЯ оценок.
 *
 * Обнуление счётчика полуходов — не косметика. Stockfish демпфирует оценку к нулю
 * по мере приближения к правилу 50 ходов, и позиция с hmvc = 80 оценивается заметно
 * ближе к нулю, чем та же позиция с hmvc = 0. Сравнивать «до» с hmvc = 80 и «после»
 * с hmvc = 0 — значит вносить систематическую ошибку БОЛЬШЕ, чем весь наш допуск ±30 сп.
 * Поэтому обнуляем в ОБЕИХ сравниваемых позициях.
 */
export function normalizeForComparison(fen) {
  const p = parseFen(fen);
  p.halfmove = 0;
  return formatFen(p);
}

/**
 * Применение десанта к позиции.
 *
 * Правила по каждому полю FEN зафиксированы явно:
 *  - расстановка: добавляем фигуры на пустые поля;
 *  - очередь хода: НЕ меняется (десант происходит в начале хода игрока);
 *  - рокировки: копируются дословно — десант не отнимает прав, даже приземлившись
 *    на a1/h1; заблокировать рокировку фигурой он может, и это нормально;
 *  - взятие на проходе: гасится, потому что между ходом соперника и нашим ответом
 *    вклинилось событие, и право на проходе теряется;
 *  - счётчик 50 ходов: сбрасывается — прибытие материала это прогресс, и без сброса
 *    длинные партии с десантами упирались бы в ничью по правилу 50 ходов;
 *  - номер хода: не меняется.
 */
export function applyDrop(fen, placements) {
  const p = parseFen(fen);
  const squares = boardToArray(p.board);
  for (const { square, piece } of placements) {
    const idx = typeof square === 'number' ? square : squareIndex(square);
    if (idx < 0 || idx > 63) throw new Error(`Десант на несуществующее поле: ${square}`);
    if (squares[idx]) throw new Error(`Десант на занятое поле: ${squareName(idx)}`);
    squares[idx] = piece;
  }
  return formatFen({
    board: arrayToBoard(squares),
    turn: p.turn,
    castling: p.castling,
    ep: '-',
    halfmove: 0,
    fullmove: p.fullmove,
  });
}

// ───────────────────────────────────────────────── подсчёты и инварианты

export function emptySquares(fen) {
  const squares = fenToArray(fen);
  const out = [];
  for (let i = 0; i < 64; i++) if (!squares[i]) out.push(i);
  return out;
}

export function countMaterial(fen) {
  const squares = fenToArray(fen);
  const counts = {
    w: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
    b: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
  };
  let total = 0;
  for (const ch of squares) {
    if (!ch) continue;
    counts[colorOfPiece(ch)][ch.toLowerCase()] += 1;
    total += 1;
  }
  return { counts, total };
}

/** Материальный перевес белых в номинальных сантипешках. */
export function materialBalance(fen) {
  const { counts } = countMaterial(fen);
  let cp = 0;
  for (const t of PIECE_TYPES) cp += (counts.w[t] - counts.b[t]) * PIECE_VALUE[t];
  return cp;
}

/**
 * Пределы, за которыми позиция перестаёт быть шахматной.
 *
 * 32 фигуры — жёсткий потолок, проверенный на этой сборке движка:
 *   31 фигура — работает, 32 — работает, 33 — Stockfish завершается с кодом 1.
 * Причина двойная. Во-первых, NNUE имеет выходные корзины по числу фигур, и 33-я
 * выводит индекс за границу массива. Во-вторых, в легальной шахматной партии больше
 * 32 фигур не бывает никогда: партия начинается с 32 и материал может только убывать.
 *
 * Отсюда прямое следствие для всей механики: десант не наращивает материал сверх
 * шахматного максимума, он ВОСПОЛНЯЕТ потери. Пока никого не разменяли, высаживать
 * некуда — трюм полон.
 */
export const LIMITS = {
  totalPieces: 32,
  pawnsPerSide: 8,
  queensPerSide: 2,
  piecesPerSide: 16,
};

/**
 * Сколько фигур ещё можно добавить на доску.
 *
 * Именно это, а не число пустых полей, ограничивает десант: в начальной позиции
 * пустых полей 32, а свободных слотов ноль.
 */
export function freeSlots(fen, limits = LIMITS) {
  const { total } = countMaterial(fen);
  return Math.max(0, limits.totalPieces - total);
}

/**
 * Можно ли вообще добавить ещё одну фигуру такого цвета и типа.
 *
 * Проверять это обязательно ДО построения пробной позиции: девятая пешка — не просто
 * нелегальная позиция, а FEN, на котором Stockfish завершается с кодом 1. Один такой
 * зонд стоит перезапуска процесса, поэтому дешёвая проверка здесь окупается сразу.
 */
export function canAddPiece(fen, color, type, limits = LIMITS) {
  if (type === 'k') return false;
  const { counts, total } = countMaterial(fen);
  if (total + 1 > limits.totalPieces) return false;
  const side = { ...counts[color] };
  const sideTotal = PIECE_TYPES.reduce((s, t) => s + side[t], 0);
  if (sideTotal + 1 > limits.piecesPerSide) return false;
  side[type] += 1;
  if (side.p > limits.pawnsPerSide) return false;
  if (side.q > limits.queensPerSide) return false;
  // Главная из проверок: сверхкомплектная фигура требует превращённой пешки.
  if (side.p + promotionDebt(side) > limits.pawnsPerSide) return false;
  return true;
}

/** Начальный комплект: сверх него фигура может появиться только превращением. */
const INITIAL_COMPLEMENT = { n: 2, b: 2, r: 2, q: 1 };

/**
 * Сколько превращений потребовалось бы, чтобы собрать такой набор фигур.
 * Каждое превращение расходует пешку, поэтому «пешки + долг» не может быть больше восьми.
 */
export function promotionDebt(sideCounts) {
  let debt = 0;
  for (const [type, initial] of Object.entries(INITIAL_COMPLEMENT)) {
    debt += Math.max(0, sideCounts[type] - initial);
  }
  return debt;
}

export function checkLimits(fen, limits = LIMITS) {
  const { counts, total } = countMaterial(fen);
  const problems = [];
  if (total > limits.totalPieces) problems.push(`фигур на доске ${total} > ${limits.totalPieces}`);
  for (const color of ['w', 'b']) {
    const side = counts[color];
    const sideTotal = PIECE_TYPES.reduce((s, t) => s + side[t], 0);
    if (side.p > limits.pawnsPerSide) problems.push(`${color}: пешек ${side.p} > ${limits.pawnsPerSide}`);
    if (side.q > limits.queensPerSide) problems.push(`${color}: ферзей ${side.q} > ${limits.queensPerSide}`);
    if (sideTotal > limits.piecesPerSide) problems.push(`${color}: фигур ${sideTotal} > ${limits.piecesPerSide}`);
    if (side.k !== 1) problems.push(`${color}: королей ${side.k}, должен быть ровно один`);

    // Правило превращений. Проверено экспериментально на этой сборке Stockfish:
    // позиция «8 пешек + 3 ладьи» роняет движок (код 1), «7 пешек + 3 ладьи» —
    // нет; «8 пешек + 2 ферзя» роняет, «6 пешек + 3 ферзя» — нет. Семь предсказаний
    // по этой формуле подтвердились семь раз из семи.
    //
    // Для десанта это ограничение первого порядка: мы добавляем фигуры свободно и
    // без него регулярно строили бы недостижимые позиции, каждая из которых стоит
    // перезапуска процесса.
    const debt = promotionDebt(side);
    if (side.p + debt > limits.pawnsPerSide) {
      problems.push(
        `${color}: пешек ${side.p} плюс ${debt} сверхкомплектных фигур — такая позиция недостижима`,
      );
    }
  }
  return problems;
}

/** Пешка на первой или восьмой горизонтали — позиция, которой не бывает. */
export function hasPawnOnBackRank(fen) {
  const squares = fenToArray(fen);
  for (let i = 0; i < 8; i++) if (squares[i] && squares[i].toLowerCase() === 'p') return true;
  for (let i = 56; i < 64; i++) if (squares[i] && squares[i].toLowerCase() === 'p') return true;
  return false;
}

/**
 * Полная проверка структурной корректности. Отдельно от проверки легальности
 * средствами chess.js: та отвечает на вопрос «бывает ли такая позиция в партии»,
 * а эта — «не сломали ли мы FEN своими руками».
 */
export function fenProblems(fen, limits = LIMITS) {
  const problems = [];
  try {
    const p = parseFen(fen);
    const squares = boardToArray(p.board);
    if (squares.length !== 64) problems.push('в расстановке не 64 поля');
    if (arrayToBoard(squares) !== p.board) problems.push('расстановка не переживает пересборку');
  } catch (err) {
    return [err.message];
  }
  if (hasPawnOnBackRank(fen)) problems.push('пешка на 1-й или 8-й горизонтали');
  problems.push(...checkLimits(fen, limits));
  return problems;
}

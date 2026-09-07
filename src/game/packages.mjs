// Таблица наборов десанта.
//
// Наборы намеренно АСИММЕТРИЧНЫ по составу: пешка со слоном против ладьи — это то,
// ради чего игра затевалась. Номинальная стоимость сторон при этом близка, но не
// равна: остаток разницы добирается выбором полей, а не подгонкой состава.
import { PIECE_VALUE, countMaterial, freeSlots, promotionDebt, LIMITS } from './fen.mjs';

/** Один вход таблицы: что получают белые и что чёрные. */
const RAW_TABLE = [
  // Малый тоннаж
  { w: ['p'], b: ['p'] },
  { w: ['p', 'p'], b: ['p', 'p'] },
  { w: ['p', 'p'], b: ['p'] },
  { w: ['n'], b: ['p', 'p', 'p'] },
  { w: ['b'], b: ['p', 'p', 'p'] },
  { w: ['n'], b: ['b'] },
  { w: ['n'], b: ['n'] },
  { w: ['b'], b: ['b'] },
  { w: ['b', 'p'], b: ['n', 'p'] },

  // Средний тоннаж
  { w: ['b', 'p'], b: ['r'] },
  { w: ['n', 'p'], b: ['r'] },
  { w: ['r'], b: ['n', 'p', 'p'] },
  { w: ['r'], b: ['b', 'p', 'p'] },
  { w: ['r'], b: ['r'] },
  { w: ['n', 'n'], b: ['r', 'p'] },
  { w: ['b', 'b'], b: ['r', 'p'] },
  { w: ['n', 'b'], b: ['r', 'p', 'p'] },
  { w: ['r', 'p'], b: ['n', 'b'] },

  // Крупный тоннаж
  { w: ['q'], b: ['r', 'r'] },
  { w: ['q'], b: ['r', 'n', 'p'] },
  { w: ['q'], b: ['r', 'b', 'p'] },
  { w: ['r', 'r'], b: ['q', 'p'] },
  { w: ['q', 'p'], b: ['r', 'r'] },
  { w: ['b', 'n', 'p'], b: ['r', 'n'] },
  { w: ['r', 'b'], b: ['q'] },
  { w: ['r', 'n', 'p'], b: ['q', 'p'] },
];

export function valueOf(list) {
  return list.reduce((s, t) => s + PIECE_VALUE[t], 0);
}

/** Тоннаж набора — по более тяжёлой стороне: это то, что видно на доске. */
export function tonnageOf(pkg) {
  return Math.max(valueOf(pkg.w), valueOf(pkg.b));
}

/** Номинальный перекос набора в POV белых. Идёт в материальный гроссбух. */
export function nominalDelta(pkg) {
  return valueOf(pkg.w) - valueOf(pkg.b);
}

export function packageSize(pkg) {
  return pkg.w.length + pkg.b.length;
}

/** Оба направления каждой строки таблицы: набор «Ф против 2Л» работает в обе стороны. */
function expand(table) {
  const out = [];
  for (const row of table) {
    out.push({ w: [...row.w], b: [...row.b] });
    const key = (p) => p.join('');
    if (key(row.w) !== key(row.b)) out.push({ w: [...row.b], b: [...row.w] });
  }
  return out.map((pkg, i) => ({ ...pkg, id: i, tonnage: tonnageOf(pkg), delta: nominalDelta(pkg) }));
}

export const PACKAGES = expand(RAW_TABLE);

/**
 * Влезает ли набор в позицию, не ломая пределов.
 * Отдельная функция, потому что проверять надо ДО поиска полей: нет смысла считать
 * маржинальную таблицу для набора, который всё равно нельзя применить.
 */
export function packageFits(fen, pkg, limits = LIMITS) {
  const { counts, total } = countMaterial(fen);
  if (total + packageSize(pkg) > limits.totalPieces) return false;

  for (const color of ['w', 'b']) {
    const add = pkg[color];
    const side = { ...counts[color] };
    for (const t of add) side[t] += 1;
    const sideTotal = Object.values(side).reduce((s, n) => s + n, 0);
    if (side.p > limits.pawnsPerSide) return false;
    if (side.q > limits.queensPerSide) return false;
    if (sideTotal > limits.piecesPerSide) return false;
    // Сверхкомплектные фигуры требуют превращённых пешек — иначе позиция недостижима
    // и Stockfish на ней завершается.
    if (side.p + promotionDebt(side) > limits.pawnsPerSide) return false;
  }
  return true;
}

/**
 * Выбор набора под заданный тоннаж.
 *
 * Учитывается три вещи сверх самого тоннажа:
 *  - теснота: чем меньше пустых полей, тем сильнее сдвиг к мелким наборам,
 *    иначе доска за десяток десантов превращается в кашу и упирается в предел 32;
 *  - гроссбух: накопленный номинальный перекос гасится выбором набора в другую сторону,
 *    потому что «ноль по оценке» и «поровну материала» — это разные вещи, и вторую
 *    люди замечают глазами;
 *  - предпочтение асимметрии: симметричные наборы допустимы, но это не то, ради чего игра.
 */
export function samplePackage(rng, { fen, budgetCp = 400, ledgerCp = 0, limits = LIMITS, exclude = [] } = {}) {
  // Ограничивает десант число СВОБОДНЫХ СЛОТОВ, а не пустых полей: в начальной
  // позиции пустых полей 32, а добавить нельзя ни одной фигуры.
  const roomForPieces = freeSlots(fen, limits);
  if (roomForPieces < 2) return null; // минимальный десант — по фигуре каждой стороне

  // Чем меньше слотов, тем мельче наборы: иначе первый же крупный десант забьёт
  // доску под потолок и следующие станут невозможны.
  const roominess = Math.min(1, roomForPieces / 10);
  const effectiveBudget = Math.max(100, Math.round(budgetCp * (0.45 + 0.55 * roominess)));

  const excluded = new Set(exclude);
  const candidates = PACKAGES.filter(
    (pkg) => !excluded.has(pkg.id) && packageSize(pkg) <= roomForPieces && packageFits(fen, pkg, limits),
  );
  if (candidates.length === 0) return null;

  const scored = candidates.map((pkg) => {
    // Близость к бюджету — основной вес.
    const distance = Math.abs(pkg.tonnage - effectiveBudget);
    let weight = 1 / (1 + (distance / 220) ** 2);
    // Гроссбух: если белым уже выдали больше, награждаем наборы в пользу чёрных.
    if (ledgerCp !== 0) {
      const corrective = -Math.sign(ledgerCp) * Math.sign(pkg.delta || 0);
      const strength = Math.min(1, Math.abs(ledgerCp) / 300);
      weight *= 1 + corrective * strength * 0.9;
    }
    // Асимметрия состава — то, ради чего механика существует.
    if (pkg.w.length !== pkg.b.length) weight *= 1.45;
    return { pkg, weight: Math.max(0.001, weight) };
  });

  const chosen = rng.weighted(scored, (x) => x.weight);
  return chosen ? chosen.pkg : null;
}

/**
 * Ремонт набора вместо полной пересборки: если по оценке не хватило совсем немного,
 * дешевле подправить состав, чем считать всё заново — маржинальная таблица уже готова
 * и переиспользуется целиком.
 *
 * @param {'w'|'b'} side  кому добавить веса
 */
export function repairPackage(pkg, side, { fen, limits = LIMITS } = {}) {
  const other = side === 'w' ? 'b' : 'w';

  // Вариант 1: добавить пешку недобирающей стороне.
  const withPawn = { ...pkg, w: [...pkg.w], b: [...pkg.b] };
  withPawn[side] = [...withPawn[side], 'p'];
  if (!fen || packageFits(fen, withPawn, limits)) {
    return { ...withPawn, id: `${pkg.id}+p${side}`, tonnage: tonnageOf(withPawn), delta: nominalDelta(withPawn) };
  }

  // Вариант 2: разменять коня противоположной стороны на три пешки — тот же тоннаж,
  // но совсем другая позиция, и часто этого хватает, чтобы сойтись по оценке.
  const idx = pkg[other].indexOf('n');
  if (idx >= 0) {
    const swapped = { ...pkg, w: [...pkg.w], b: [...pkg.b] };
    swapped[other] = [...swapped[other]];
    swapped[other].splice(idx, 1, 'p', 'p', 'p');
    if (!fen || packageFits(fen, swapped, limits)) {
      return { ...swapped, id: `${pkg.id}~n${other}`, tonnage: tonnageOf(swapped), delta: nominalDelta(swapped) };
    }
  }
  return null;
}

/** Человеческое имя набора для журнала: «▲ Слон + пешка против ладьи». */
const RU_PIECE = { p: 'пешка', n: 'конь', b: 'слон', r: 'ладья', q: 'ферзь' };
export function describePackage(pkg) {
  const side = (list) => list.map((t) => RU_PIECE[t]).join(' + ');
  return `${side(pkg.w)} против ${side(pkg.b)}`;
}

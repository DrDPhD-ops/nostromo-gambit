// Маржинальная таблица и композиция встречным ходом.
//
// Это замена слепому сэмплингу расстановок. Наивный перебор нежизнеспособен:
// три фигуры по ~30 пустых полей дают около 15 тысяч совместных расстановок,
// и даже по 60 мс на оценку это четверть часа на один десант.
//
// Наблюдение, которое всё меняет: задача о балансе почти одномерна. Вклад каждой
// отдельной фигуры на каждом отдельном поле можно измерить ОДИН раз статической
// оценкой (~2 мс), а дальше искать не расстановку, а ПАРУ СУММ, дающую нужную дельту.
// Суммы белых сортируются, суммы чёрных сортируются, и нужное сочетание находится
// двоичным поиском вместо перебора произведения.
//
// Предсказание приблизительно: оно не видит взаимодействий фигур и тактики.
// Оно и не должно — его работа в том, чтобы дать движку хороший короткий список.
import { applyDrop, squareName } from './fen.mjs';
import { legalSquaresFor, enginePositionProblem } from './dropRules.mjs';

/** Ключ ячейки таблицы. */
export function marginalKey(color, type, square) {
  return `${color}:${type}:${square}`;
}

/**
 * Строит таблицу вкладов: для каждой нужной пары (цвет, тип) и каждого допустимого
 * поля — предсказанный сдвиг оценки в POV белых.
 *
 * @param {object} pool          пул движков
 * @param {string} fen           позиция до десанта
 * @param {Array<{color,type}>} needs  какие пары действительно нужны набору
 */
export async function buildMarginalTable(
  pool,
  fen,
  needs,
  { signal = null, dropOptions = {}, onProgress = null, maxProbesPerNeed = 0, rng = null } = {},
) {
  const baseline = await pool.staticEval(fen, { priority: 'urgent', signal });
  const table = new Map();
  const squaresByNeed = new Map();

  const jobs = [];
  for (const need of needs) {
    const key = `${need.color}:${need.type}`;
    if (squaresByNeed.has(key)) continue;
    let squares = legalSquaresFor(fen, need.color, need.type, dropOptions);
    // Каждый зонд — отдельный обход в движок и обратно, и на замере это оказалось
    // примерно 30 мс накладных на зонд против 2 мс самой оценки. Поэтому при большом
    // числе допустимых полей берём подвыборку. Выбор равномерный по доске, а не
    // случайный кусок: нам важен весь диапазон возможных вкладов, а не его часть.
    if (maxProbesPerNeed > 0 && squares.length > maxProbesPerNeed) {
      const step = (squares.length - 1) / (maxProbesPerNeed - 1);
      const offset = rng ? rng.float() * 0.9 : 0;
      const picked = new Set();
      for (let i = 0; i < maxProbesPerNeed; i++) {
        picked.add(squares[Math.min(squares.length - 1, Math.round(i * step + offset))]);
      }
      squares = [...picked];
    }
    squaresByNeed.set(key, squares);
    for (const sq of squares) {
      jobs.push({ color: need.color, type: need.type, square: sq });
    }
  }

  let done = 0;
  const results = await pool.map(
    jobs,
    async (engine, job) => {
      const piece = job.color === 'w' ? job.type.toUpperCase() : job.type.toLowerCase();
      const probe = applyDrop(fen, [{ square: job.square, piece }]);
      // Страховка перед отправкой. Отправить движку нелегальную позицию —
      // это не «получить плохое число», это гарантированное падение процесса
      // и его перезапуск. Проверка стоит десятки микросекунд, падение — секунду.
      const unsafe = enginePositionProblem(probe);
      if (unsafe) return null;
      const cp = await engine.staticEval(probe);
      done += 1;
      if (onProgress && done % 16 === 0) onProgress(done, jobs.length);
      return cp;
    },
    { signal },
  );

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const cp = results[i];
    // Под шахом статической оценки не существует — такие поля просто выпадают.
    if (cp === null || baseline === null) continue;
    table.set(marginalKey(job.color, job.type, job.square), cp - baseline);
  }

  return { table, baseline, squaresByNeed, probes: jobs.length };
}

/** Сочетания без повторов, с ограничением сверху по количеству. */
function* combinations(items, k) {
  const n = items.length;
  if (k > n || k <= 0) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx.map((i) => items[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i -= 1;
    if (i < 0) return;
    idx[i] += 1;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

/** Оценка числа сочетаний без переполнения. */
function countCombinations(n, k) {
  if (k > n || k <= 0) return 0;
  let c = 1;
  for (let i = 0; i < k; i++) {
    c = (c * (n - i)) / (i + 1);
    if (c > 1e7) return Infinity;
  }
  return Math.round(c);
}

/**
 * Прореживание списка полей, когда сочетаний получается слишком много.
 * Берём равномерно по ОТСОРТИРОВАННОМУ вкладу, а не случайно: нам нужен весь
 * диапазон возможных сумм, а не случайный его кусок.
 */
function thinSquares(entries, keep) {
  if (entries.length <= keep) return entries;
  const sorted = [...entries].sort((a, b) => a.cp - b.cp);
  const step = (sorted.length - 1) / (keep - 1);
  const out = [];
  for (let i = 0; i < keep; i++) out.push(sorted[Math.round(i * step)]);
  return out;
}

/**
 * Все варианты расстановки одного набора одной стороны с предсказанной суммой вклада.
 * Возвращает отсортированный по сумме массив — на нём работает двоичный поиск.
 */
export function enumerateSideOptions(set, color, table, squaresByNeed, { maxOptions = 20000 } = {}) {
  // Группируем одинаковые типы: три пешки — это выбор трёх полей из одного списка.
  const byType = new Map();
  for (const type of set) byType.set(type, (byType.get(type) || 0) + 1);

  let options = [{ squares: [], cp: 0 }];

  for (const [type, count] of byType) {
    const squares = squaresByNeed.get(`${color}:${type}`) || [];
    let entries = squares
      .map((sq) => ({ square: sq, cp: table.get(marginalKey(color, type, sq)) }))
      .filter((e) => Number.isFinite(e.cp));
    if (entries.length < count) return [];

    // Держим взрыв сочетаний под контролем.
    let budget = Math.max(1, Math.floor(maxOptions / Math.max(1, options.length)));
    while (countCombinations(entries.length, count) > budget && entries.length > count) {
      entries = thinSquares(entries, Math.max(count, Math.floor(entries.length * 0.75)));
    }

    const next = [];
    for (const base of options) {
      for (const combo of combinations(entries, count)) {
        const squares2 = combo.map((c) => c.square);
        if (squares2.some((s) => base.squares.includes(s))) continue;
        next.push({
          squares: [...base.squares, ...squares2],
          types: [...(base.types || []), ...combo.map(() => type)],
          cp: base.cp + combo.reduce((s, c) => s + c.cp, 0),
        });
        if (next.length >= maxOptions) break;
      }
      if (next.length >= maxOptions) break;
    }
    options = next;
    if (options.length === 0) return [];
  }

  // Проставляем типы там, где набор состоял из одного типа.
  for (const opt of options) {
    if (!opt.types) opt.types = set.slice(0, opt.squares.length);
  }
  options.sort((a, b) => a.cp - b.cp);
  return options;
}

function lowerBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].cp < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Встречный ход: для каждой расстановки белых двоичным поиском находим расстановку
 * чёрных, чья сумма ближе всего к нужной. Это и есть замена перебору произведения.
 *
 * @param {number} target  желаемая суммарная дельта в POV белых (0 или заданный перекос)
 */
export function meetInTheMiddle(whiteOptions, blackOptions, target, { count = 32, probeWidth = 3 } = {}) {
  if (whiteOptions.length === 0 || blackOptions.length === 0) return [];
  const pairs = [];
  const seen = new Set();

  for (const w of whiteOptions) {
    const want = target - w.cp;
    const at = lowerBound(blackOptions, want);
    for (let k = at - probeWidth; k <= at + probeWidth; k++) {
      if (k < 0 || k >= blackOptions.length) continue;
      const b = blackOptions[k];
      // Поля белых и чёрных не должны пересекаться.
      if (b.squares.some((s) => w.squares.includes(s))) continue;
      const predicted = w.cp + b.cp;
      const key = `${w.squares.join(',')}|${b.squares.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ white: w, black: b, predicted, error: Math.abs(predicted - target) });
    }
  }

  pairs.sort((a, b) => a.error - b.error);
  return pairs.slice(0, count);
}

/** Превращает пару расстановок в плоский список размещений. */
export function pairToPlacements(pair) {
  const out = [];
  pair.white.squares.forEach((sq, i) => out.push({ square: sq, color: 'w', type: pair.white.types[i] }));
  pair.black.squares.forEach((sq, i) => out.push({ square: sq, color: 'b', type: pair.black.types[i] }));
  return out;
}

/** Читаемое описание расстановки для журнала. */
export function describePlacements(placements) {
  const side = (color) =>
    placements
      .filter((p) => p.color === color)
      .map((p) => `${p.type.toUpperCase()}${squareName(typeof p.square === 'number' ? p.square : 0)}`)
      .join(' ');
  return { w: side('w'), b: side('b') };
}

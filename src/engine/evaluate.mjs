// Разбор вывода движка и приведение оценок к одному основанию.
//
// Здесь живут две РАЗНЫЕ нормализации, и путать их нельзя:
//   * `info ... score cp N`  — от лица стороны, которая ходит;
//   * вывод команды `eval`   — всегда от лица белых.
// Всё, что уходит наружу, приведено к POV белых: плюс = лучше белым.

/** Мат кодируется как очень большая cp, монотонно по расстоянию до мата. */
export const MATE_CP_BASE = 30000;
/** Порог, выше которого cp считается матовым классом, а не обычной оценкой. */
export const MATE_CP_THRESHOLD = 20000;

/** Масштаб логистического преобразования cp -> вероятность победы. */
export const WIN_PROB_SCALE = 350;

/**
 * mate N -> cp. Монотонно (mate 1 «лучше» mate 5) и насыщается, чтобы
 * разница между mate 40 и mate 60 не перевешивала всё остальное.
 */
export function mateToCp(movesToMate) {
  const sign = movesToMate >= 0 ? 1 : -1;
  const n = Math.min(Math.abs(movesToMate), 200);
  // Шаг 40, а не 50: при насыщении (n = 200) должно остаться 22000 сп, заведомо выше
  // MATE_CP_THRESHOLD. С шагом 50 самый дальний мат давал ровно 20000 и переставал
  // опознаваться как мат — граница попадала точно в порог.
  return sign * (MATE_CP_BASE - n * 40);
}

/** Скалярное представление оценки для сравнений и сортировок. */
export function scoreToCp(score) {
  if (!score) return null;
  return score.kind === 'mate' ? mateToCp(score.value) : score.value;
}

export function isMate(score) {
  return Boolean(score) && score.kind === 'mate';
}

/** Оценка от лица белых -> от лица стороны к ходу, и обратно (операция своя обратная). */
export function flipPov(score) {
  if (!score) return null;
  return { kind: score.kind, value: -score.value };
}

export function toWhitePov(score, sideToMove) {
  return sideToMove === 'w' ? score : flipPov(score);
}

/**
 * Вероятность победы белых. Линейная шкала бесполезна: интересный диапазон ±80 сп
 * на ней невидим, а ±1500 упирается в край.
 */
export function winProbability(cp) {
  if (cp >= MATE_CP_THRESHOLD) return 1;
  if (cp <= -MATE_CP_THRESHOLD) return 0;
  return 1 / (1 + Math.exp(-cp / WIN_PROB_SCALE));
}

/** «+1.35» / «M4» / «-M2» — то, что видит человек. */
export function formatScore(score) {
  if (!score) return '—';
  if (score.kind === 'mate') return `${score.value < 0 ? '-' : ''}M${Math.abs(score.value)}`;
  const pawns = score.value / 100;
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`;
}

// ───────────────────────────────────────────────── разбор строк info

const INT_FIELDS = ['depth', 'seldepth', 'multipv', 'nodes', 'nps', 'time', 'hashfull'];

/**
 * Разбирает одну строку `info`. Возвращает null, если строка не несёт оценки
 * или помечена как граница окна поиска (lowerbound / upperbound) — такие значения
 * не являются настоящей оценкой позиции и в кривую попадать не должны.
 */
export function parseInfoLine(line) {
  if (typeof line !== 'string') return null;
  const t = line.trim();
  if (!t.startsWith('info ')) return null;
  if (t.includes(' lowerbound') || t.includes(' upperbound')) return null;
  if (!t.includes(' score ')) return null;
  if (!t.includes(' depth ')) return null;

  const tok = t.split(/\s+/);
  const out = { pv: null, wdl: null, score: null };

  for (let i = 1; i < tok.length; i++) {
    const key = tok[i];
    if (INT_FIELDS.includes(key)) {
      const v = Number(tok[i + 1]);
      if (Number.isFinite(v)) out[key] = v;
      i++;
    } else if (key === 'score') {
      const kind = tok[i + 1];
      const value = Number(tok[i + 2]);
      if ((kind === 'cp' || kind === 'mate') && Number.isFinite(value)) {
        out.score = { kind, value };
      }
      i += 2;
    } else if (key === 'wdl') {
      const w = Number(tok[i + 1]);
      const d = Number(tok[i + 2]);
      const l = Number(tok[i + 3]);
      if ([w, d, l].every(Number.isFinite)) out.wdl = { w, d, l };
      i += 3;
    } else if (key === 'pv') {
      out.pv = tok.slice(i + 1);
      break;
    }
  }

  if (!out.score || !Number.isFinite(out.depth)) return null;
  return out;
}

/** Вывод команды `eval` — статическая оценка, всегда от лица белых. */
export function parseEvalOutput(text) {
  if (typeof text !== 'string') return null;
  if (/Final evaluation:?\s*none/i.test(text)) return null; // позиция под шахом
  const m = /Final evaluation:?\s*([+-]?\d+(?:\.\d+)?)/i.exec(text);
  if (!m) return null;
  return Math.round(Number(m[1]) * 100);
}

// ───────────────────────────────────────────────── кривая «оценка по глубине»

/**
 * Копилка оценок одного поиска: для каждой глубины хранится ПОСЛЕДНЯЯ принятая строка.
 * Кривая нужна не ради красоты: сравнивать позиции «до» и «после» можно только на
 * одинаковой глубине, а разброс соседних глубин — это и есть мера остроты позиции.
 */
export function createCurve() {
  return { byDepth: new Map(), maxDepth: 0, nodes: 0, pv: null, sideToMove: 'w' };
}

/** Кладёт разобранную строку в кривую, попутно приводя оценку к POV белых. */
export function feedCurve(curve, parsed, sideToMove) {
  if (!parsed || !parsed.score) return curve;
  const white = toWhitePov(parsed.score, sideToMove);
  curve.byDepth.set(parsed.depth, { ...white, wdl: parsed.wdl || null });
  if (parsed.depth >= curve.maxDepth) {
    curve.maxDepth = parsed.depth;
    if (parsed.pv) curve.pv = parsed.pv;
  }
  if (Number.isFinite(parsed.nodes)) curve.nodes = parsed.nodes;
  curve.sideToMove = sideToMove;
  return curve;
}

/**
 * Оценка на заданной глубине. Если на этой и предыдущей глубине обе оценки обычные,
 * усредняем их: одиночная итерация часто «дёргается» на ±10 сп, а нам нужна цифра,
 * по которой принимается решение о десанте.
 */
export function scoreAt(curve, depth) {
  const here = curve.byDepth.get(depth);
  if (!here) return null;
  const prev = curve.byDepth.get(depth - 1);
  if (here.kind === 'cp' && prev && prev.kind === 'cp') {
    return { kind: 'cp', value: Math.round(0.5 * here.value + 0.5 * prev.value) };
  }
  return { kind: here.kind, value: here.value };
}

/**
 * Разброс оценки по последним `window` глубинам, в сантипешках.
 * Малый разброс = тихая позиция, большой = позиция, где мелкий и глубокий поиск
 * расходятся, то есть тактически заряженная. МАТЬ это минимизирует, ЭШ максимизирует.
 */
export function depthSpread(curve, depth, window = 3) {
  const vals = [];
  for (let d = depth; d > depth - window && d > 0; d--) {
    const s = curve.byDepth.get(d);
    if (s) vals.push(scoreToCp(s));
  }
  if (vals.length < 2) return 0;
  return Math.max(...vals) - Math.min(...vals);
}

/** Наибольшая глубина, достигнутая всеми кривыми — единственная честная точка сравнения. */
export function commonDepth(curves) {
  let d = Infinity;
  for (const c of curves) {
    if (!c || !c.maxDepth) return 0;
    d = Math.min(d, c.maxDepth);
  }
  return Number.isFinite(d) ? d : 0;
}

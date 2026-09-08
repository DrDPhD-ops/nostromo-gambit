// Генератор сбалансированного десанта. Ядро продукта.
//
// Задача: выдать обеим сторонам разный по составу материал на конкретные поля так,
// чтобы оценка позиции не сдвинулась (или сдвинулась ровно на разыгранный перекос).
//
// Четыре ступени с сужением:
//   0. маржинальная таблица       — статическая оценка вклада каждой фигуры на каждом поле
//   1. композиция встречным ходом — пары сумм, дающие нужную дельту
//   2. отбор движком              — короткий поиск по кандидатам (кратно размеру пула)
//   3. подтверждение              — длинный поиск по лучшим, с MultiPV 2
// Между ступенями 2 и 3 вклинивается коррекция: промах маржинального предсказания
// измеряется по результатам отбора и цель сдвигается, вместо полного нового захода.
//
// Два правила, без которых всё остальное бессмысленно:
//   * бюджет задаётся в УЗЛАХ, а не в глубине: `go depth N` невоспроизводим под нагрузкой;
//   * базовая оценка ПЕРЕИЗМЕРЯЕТСЯ в каждом раунде тем же бюджетом, что и кандидаты.
//     Сравнивать глубокую базу с мелким кандидатом — систематическая ошибка больше допуска.
import { squareName, mirrorSquare, rankOf, PIECE_VALUE } from './fen.mjs';
import { normalizeForComparison } from './fen.mjs';
import { validatePlacement, deferReason, DEFAULT_DROP_OPTIONS, legalSquaresFor } from './dropRules.mjs';
import { samplePackage, repairPackage, describePackage, nominalDelta } from './packages.mjs';
import { buildMarginalTable, enumerateSideOptions, meetInTheMiddle, pairToPlacements } from './marginal.mjs';
import { characterOf, characterPenalty } from './sharpness.mjs';
import { getStoryteller, storytellerSkew } from './storytellers.mjs';
import { combineSkew } from './dice.mjs';
import { scoreAt, scoreToCp, isMate, commonDepth } from '../engine/evaluate.mjs';

export const DEFAULT_BUDGET = {
  /** На сколько миллисекунд поиска мы вообще замахиваемся. */
  targetMs: 2200,
  /** Жёсткий предел: за ним десант откладывается, чего бы он ни насчитал. */
  hardMs: 4200,
  /** Сколько волн отбора прогоняем: кандидатов будет ровно волн × размер пула. */
  screenWaves: 4,
  /** Если скорость пула неизвестна, берём осторожную оценку. */
  fallbackNps: 1_200_000,
  minScreenNodes: 20000,
  minVerifyNodes: 80000,
  /** Ограничение на число зондов маржинальной таблицы на пару (цвет, тип). */
  maxProbesPerNeed: 22,
};

/** Раунд сравнения считается пригодным только начиная с этой глубины. */
const MIN_COMPARABLE_DEPTH = 5;

/**
 * Бюджеты узлов и размеры выборок из измеренной скорости и ФОРМЫ пула.
 *
 * Форма важна не меньше скорости: пул из 5 воркеров выполняет задачи волнами по 5,
 * и 32 кандидата — это 6.4 волны, где последняя занимает один воркер, а четыре стоят.
 * Поэтому число кандидатов округляется до кратного размеру пула, а на подтверждение
 * идёт ровно (размер пула − 1) кандидатов: вместе с переизмерением базы это ровно
 * одна полная волна. Замер показал, что именно на этом терялось около секунды.
 */
export function planBudgets(aggregateNps, cfg = DEFAULT_BUDGET, poolSize = 5) {
  const nps = aggregateNps > 0 ? aggregateNps : cfg.fallbackNps;
  const workers = Math.max(1, poolSize);
  const screenCandidates = Math.max(workers, cfg.screenWaves * workers);
  const verifyCandidates = Math.max(2, workers - 1);

  const totalNodes = (cfg.targetMs / 1000) * nps;
  const screenNodes = Math.max(cfg.minScreenNodes, Math.round((totalNodes * 0.45) / screenCandidates));
  const verifyNodes = Math.max(cfg.minVerifyNodes, Math.round((totalNodes * 0.55) / (verifyCandidates + 1)));
  return {
    screenNodes,
    verifyNodes,
    screenCandidates,
    verifyCandidates,
    workers,
    totalNodes: Math.round(totalNodes),
    nps,
  };
}

/**
 * Сравнение кандидата с базой на общей глубине.
 * Возвращает null, если сравнение недостоверно: разная глубина, слишком мелко,
 * или появился/исчез мат — такие случаи обязаны выпадать, а не превращаться в число.
 */
function compareToBaseline(baseline, candidate) {
  const depth = commonDepth([baseline.curve, candidate.curve]);
  if (depth < MIN_COMPARABLE_DEPTH) return null;
  const e0 = scoreAt(baseline.curve, depth);
  const e1 = scoreAt(candidate.curve, depth);
  if (!e0 || !e1) return null;
  // Мат в базе — отдельный случай, он отсекается раньше. Мат у кандидата означает,
  // что десант создал форсированный выигрыш: это не «нулевая дельта», это провал.
  if (isMate(e0) || isMate(e1)) return { depth, delta: null, mate: true, e0, e1 };
  return { depth, delta: scoreToCp(e1) - scoreToCp(e0), mate: false, e0, e1 };
}

/** Пары (цвет, тип), для которых нужна маржинальная таблица. */
function needsOf(pkg) {
  const set = new Set();
  for (const t of pkg.w) set.add(`w:${t}`);
  for (const t of pkg.b) set.add(`b:${t}`);
  return [...set].map((k) => {
    const [color, type] = k.split(':');
    return { color, type };
  });
}

/**
 * Зеркальный десант: одинаковая фигура белым на поле и чёрным на поле, отражённое
 * по горизонтали. В симметричной позиции это ровно ноль, в любой другой — близко к нему.
 * Почти гарантированный запасной вариант, а в разрежённом эндшпиле — основной:
 * там одна лишняя пешка нелинейно решает исход, и подбирать состав опасно.
 */
function mirrorCandidates(fen, dropOptions, limit = 24) {
  const out = [];
  for (const type of ['n', 'b', 'r', 'p']) {
    const whiteSquares = new Set(legalSquaresFor(fen, 'w', type, dropOptions));
    const blackSquares = new Set(legalSquaresFor(fen, 'b', type, dropOptions));
    for (const sq of whiteSquares) {
      const twin = mirrorSquare(sq);
      if (twin === sq) continue;
      if (!blackSquares.has(twin)) continue;
      if (type === 'p' && (rankOf(sq) === 1 || rankOf(sq) === 8)) continue;
      out.push({
        placements: [
          { square: sq, color: 'w', type },
          { square: twin, color: 'b', type },
        ],
        pkg: { w: [type], b: [type], id: `mirror:${type}`, tonnage: PIECE_VALUE[type], delta: 0 },
      });
    }
  }
  return out.slice(0, limit);
}

/**
 * Главная функция.
 *
 * @param {object} pool                  пул движков
 * @param {string} fen                   позиция в начале хода игрока
 * @param {object} opts
 * @param {import('./rng.mjs').Rng} opts.rng
 * @param {string} opts.storytellerId
 * @param {object|null} opts.dice        разобранный бросок или null для авто-десанта
 * @param {number} opts.ledgerCp         накопленный номинальный перекос выданного материала
 */
export async function generateBalancedDrop(pool, fen, opts = {}) {
  const t0 = Date.now();
  const {
    rng,
    storytellerId = 'bishop',
    dice = null,
    ledgerCp = 0,
    signal = null,
    onProgress = null,
    budget = DEFAULT_BUDGET,
    aggregateNps = 0,
    dropOptions: dropOptionsIn = {},
    toleranceOverride = null,
  } = opts;

  const storyteller = getStoryteller(storytellerId);
  const dropOptions = { ...DEFAULT_DROP_OPTIONS, ...dropOptionsIn };
  const ladder = [];
  const progress = (phase, done, total) => {
    if (onProgress) onProgress({ phase, done, total, elapsedMs: Date.now() - t0 });
  };

  const bail = (reason, extra = {}) => ({
    ok: false,
    skipped: true,
    reason,
    ladder,
    searchMs: Date.now() - t0,
    storyteller: storyteller.id,
    ...extra,
  });

  // ── Ворота позиции: есть положения, в которых десантировать не следует вовсе.
  const defer = deferReason(fen, dropOptions);
  if (defer) return bail(defer);

  const baseTolerance = toleranceOverride ?? storyteller.toleranceCp;
  const ownSkew = storytellerSkew(storyteller, rng);
  const targetDelta = combineSkew(dice ? dice.skewCp : 0, ownSkew);
  const budgets = planBudgets(aggregateNps, budget, opts.poolSize || pool.size || 5);

  progress('baseline', 0, 1);

  // ── Проверка на мат делается ДЕШЁВЫМ поиском.
  // Раньше здесь стоял полный подтверждающий бюджет, и база считалась дважды:
  // один раз ради этой проверки и ещё раз внутри раунда подтверждения. Замер показал
  // на этом около 400 мс на каждый десант. Форсированный мат виден и мелким поиском —
  // если он не виден на этом бюджете, он не повлияет и на решение о десанте.
  const probeFen = normalizeForComparison(fen);
  const firstLook = await pool.analyse(
    { fen: probeFen, nodes: budgets.screenNodes, newGame: true },
    { priority: 'urgent', signal },
  );
  const firstScore = scoreAt(firstLook.curve, firstLook.curve.maxDepth);
  if (isMate(firstScore)) {
    return bail('в позиции форсированный мат — десант не вмешивается', { evalBefore: firstScore });
  }

  const budgetCp = dice
    ? dice.budgetCp
    : rng.int(storyteller.autoBudgetCp[0], storyteller.autoBudgetCp[1]);

  const triedPackages = [];
  let best = null; // лучший кандидат за все попытки, даже если не уложился в допуск

  /** Один заход: набор -> таблица -> композиция -> отбор -> подтверждение. */
  // Маржинальные таблицы переиспользуются между наборами: пары (цвет, тип) у разных
  // наборов часто совпадают, а каждый пересчёт — это сотня обходов в движок.
  const tableCache = { table: new Map(), squaresByNeed: new Map(), probes: 0 };

  const ensureTable = async (needs) => {
    const missing = needs.filter((n) => !tableCache.squaresByNeed.has(`${n.color}:${n.type}`));
    if (missing.length > 0) {
      progress('table', 0, 1);
      const built = await buildMarginalTable(pool, probeFen, missing, {
        signal,
        dropOptions,
        maxProbesPerNeed: budget.maxProbesPerNeed,
        rng,
        onProgress: (done, total) => progress('table', done, total),
      });
      for (const [k, v] of built.table) tableCache.table.set(k, v);
      for (const [k, v] of built.squaresByNeed) tableCache.squaresByNeed.set(k, v);
      tableCache.probes += built.probes;
    }
    return tableCache;
  };

  /** Составить пачку легальных кандидатов под заданную цель по дельте. */
  const compose = (pkg, table, squaresByNeed, target, skip = new Set()) => {
    const whiteOptions = enumerateSideOptions(pkg.w, 'w', table, squaresByNeed);
    const blackOptions = enumerateSideOptions(pkg.b, 'b', table, squaresByNeed);
    if (whiteOptions.length === 0 || blackOptions.length === 0) return [];

    // Берём с запасом: часть пар отсеется проверками легальности.
    const pairs = meetInTheMiddle(whiteOptions, blackOptions, target, {
      count: budgets.screenCandidates * 5,
    });

    const legal = [];
    for (const pair of pairs) {
      if (legal.length >= budgets.screenCandidates) break;
      const placements = pairToPlacements(pair);
      const key = placements.map((p) => `${p.color}${p.type}${p.square}`).sort().join('|');
      if (skip.has(key)) continue;
      const check = validatePlacement(probeFen, placements, dropOptions);
      if (!check.ok) continue;
      skip.add(key);
      legal.push({ placements, fen: check.fen, predicted: pair.predicted, pkg, key });
    }
    return legal;
  };

  const attempt = async (pkg, label) => {
    const needs = needsOf(pkg);
    const { table, squaresByNeed, probes } = await ensureTable(needs);

    const seen = new Set();
    const legal = compose(pkg, table, squaresByNeed, targetDelta, seen);
    if (legal.length === 0) {
      ladder.push({ step: label, result: 'нет допустимых расстановок для набора', probes });
      return null;
    }

    const first = await runRounds(legal, pkg, label, probes);
    if (!first) return null;

    // ── Коррекция предсказания.
    //
    // Маржинальная таблица складывает вклады фигур независимо и потому системно
    // промахивается: она не видит их взаимодействия. Промах оказался почти линейным,
    // и его дешевле ИЗМЕРИТЬ по результатам отбора, чем гадать. Если лучший кандидат
    // далеко от цели, мы не берём новый набор (это ещё один полный заход со всеми
    // ступенями), а пересобираем расстановки того же набора под смещённую цель.
    // Один дополнительный отборочный раунд стоит примерно втрое дешевле нового набора.
    const bestScreen = first.screened[0];
    const off = bestScreen.cmp.delta - targetDelta;
    if (Math.abs(off) > baseTolerance && !outOfTime()) {
      const fit = fitCorrection(first.screened, targetDelta);
      const corrected = compose(pkg, table, squaresByNeed, fit.correctedTarget, seen);
      if (corrected.length > 0) {
        ladder.push({
          step: `${label}: коррекция`,
          result: `цель предсказания сдвинута с ${targetDelta} на ${Math.round(fit.correctedTarget)} сп`,
        });
        const second = await runRounds(corrected, pkg, `${label} (после коррекции)`, 0);
        if (second) first.screened = mergeScreened(first.screened, second.screened, targetDelta);
      }
    }

    return finishRounds(first.screened, pkg, label);
  };

  /**
   * Линейная поправка «предсказано -> измерено» по результатам отбора.
   * Достаточно одного коэффициента и сдвига: интерес представляет не точность модели,
   * а то, куда сместить цель, чтобы следующая пачка легла ближе.
   */
  function fitCorrection(screened, target) {
    const pts = screened
      .filter((s) => s.cmp && Number.isFinite(s.cmp.delta) && Number.isFinite(s.predicted))
      .map((s) => [s.predicted, s.cmp.delta]);
    if (pts.length < 3) return { correctedTarget: target - (screened[0].cmp.delta - target), slope: 1 };

    const n = pts.length;
    const mx = pts.reduce((s, p) => s + p[0], 0) / n;
    const my = pts.reduce((s, p) => s + p[1], 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (const [x, y] of pts) {
      sxy += (x - mx) * (y - my);
      sxx += (x - mx) ** 2;
    }
    // Крутизна ниже 0.2 означает, что предсказание вообще не связано с измерением;
    // в таком случае честнее просто сдвинуть цель на наблюдаемую ошибку.
    const slope = sxx > 1 ? sxy / sxx : 0;
    if (Math.abs(slope) < 0.2) return { correctedTarget: target - (my - target), slope };
    const intercept = my - slope * mx;
    return { correctedTarget: (target - intercept) / slope, slope };
  }

  function mergeScreened(a, b, target) {
    return [...a, ...b]
      .filter((r) => r && r.cmp && !r.cmp.mate && r.cmp.delta !== null)
      .sort((x, y) => Math.abs(x.cmp.delta - target) - Math.abs(y.cmp.delta - target))
      .slice(0, budgets.verifyCandidates);
  }

  /**
   * Ступень 2: отбор. База переизмеряется ТЕМ ЖЕ бюджетом, что и кандидаты —
   * сравнивать глубокую базу с мелким кандидатом значит вносить систематическую
   * ошибку больше всего допуска.
   */
  const runRounds = async (legal, pkg, label, probes = 0) => {
    progress('screen', 0, legal.length);
    const screenBase = await pool.analyse(
      { fen: probeFen, nodes: budgets.screenNodes, newGame: true },
      { priority: 'urgent', signal },
    );

    let screened = 0;
    const screenResults = await pool.map(
      legal,
      async (engine, cand) => {
        const a = await engine.analyse({ fen: cand.fen, nodes: budgets.screenNodes, newGame: true });
        screened += 1;
        progress('screen', screened, legal.length);
        const cmp = compareToBaseline(screenBase, a);
        return { ...cand, screen: a, cmp };
      },
      { signal },
    );

    const usableScreen = screenResults
      .filter((r) => r.cmp && !r.cmp.mate && r.cmp.delta !== null)
      .sort((a, b) => Math.abs(a.cmp.delta - targetDelta) - Math.abs(b.cmp.delta - targetDelta));

    if (usableScreen.length === 0) {
      ladder.push({ step: label, result: 'отбор не оставил сравнимых кандидатов', probes });
      return null;
    }
    return { screened: usableScreen, probes, label, pkg };
  };

  /** Ступень 3: подтверждение лучших кандидатов на большом бюджете. */
  const finishRounds = async (screenedAll, pkg, label) => {
    const survivors = screenedAll.slice(0, budgets.verifyCandidates);
    if (survivors.length === 0) return null;
    const probes = tableCache.probes;

    progress('verify', 0, survivors.length);
    const verifyBase = await pool.analyse(
      { fen: probeFen, nodes: budgets.verifyNodes, multipv: 2, newGame: true },
      { priority: 'urgent', signal },
    );

    let verified = 0;
    const finals = await pool.map(
      survivors,
      async (engine, cand) => {
        // MultiPV 2 здесь не роскошь: разрыв до второго хода — это терм «единственного
        // хода», и он достаётся из того же поиска даром.
        const a = await engine.analyse({ fen: cand.fen, nodes: budgets.verifyNodes, multipv: 2, newGame: true });
        verified += 1;
        progress('verify', verified, survivors.length);
        const cmp = compareToBaseline(verifyBase, a);
        if (!cmp || cmp.mate || cmp.delta === null) return null;
        const character = characterOf(probeFen, cand.fen, cand.placements, a);
        const error = Math.abs(cmp.delta - targetDelta);
        const cost = error + characterPenalty(character, storyteller.weights);
        return { ...cand, verify: a, cmp, character, error, cost, pkg };
      },
      { priority: 'urgent', signal },
    );

    const usable = finals.filter(Boolean);
    if (usable.length === 0) {
      ladder.push({ step: label, result: 'подтверждение отсеяло всех кандидатов', probes });
      return null;
    }

    usable.sort((a, b) => a.cost - b.cost);
    const winner = usable[0];
    // Лучший по ошибке — отдельно от лучшего по стоимости: для лестницы важна именно ошибка.
    const closest = [...usable].sort((a, b) => a.error - b.error)[0];
    if (!best || closest.error < best.error) best = { ...closest, baseline: verifyBase, label };

    ladder.push({
      step: label,
      result: `лучшая ошибка ${closest.error} сп, выбран кандидат с ошибкой ${winner.error} сп`,
      probes,
      candidates: screenedAll.length,
    });

    return { ...winner, baseline: verifyBase, label };
  };

  // ─────────────────────────────── лестница попыток

  const outOfTime = () => Date.now() - t0 > budget.hardMs;

  // 1-3. До трёх наборов, с ремонтом состава между ними.
  for (let round = 0; round < 3 && !outOfTime(); round++) {
    const pkg = samplePackage(rng, {
      fen: probeFen,
      budgetCp,
      ledgerCp,
      limits: dropOptions.limits,
      exclude: triedPackages,
    });
    if (!pkg) break;
    triedPackages.push(pkg.id);

    const result = await attempt(pkg, `набор ${round + 1}: ${describePackage(pkg)}`);
    if (result && result.error <= baseTolerance) {
      return finish(result, baseTolerance);
    }

    // Ремонт состава дешевле пересборки: маржинальная таблица уже посчитана,
    // а сдвиг на одну пешку часто и есть недостающее.
    if (result && !outOfTime()) {
      const shortSide = result.cmp.delta > targetDelta ? 'b' : 'w';
      const repaired = repairPackage(pkg, shortSide, { fen: probeFen, limits: dropOptions.limits });
      if (repaired) {
        const repairedResult = await attempt(repaired, `ремонт: ${describePackage(repaired)}`);
        if (repairedResult && repairedResult.error <= baseTolerance) {
          return finish(repairedResult, baseTolerance);
        }
      }
    }
  }

  // 4. Зеркальный десант.
  if (!outOfTime()) {
    const mirrors = mirrorCandidates(probeFen, dropOptions);
    const legal = [];
    for (const m of mirrors) {
      const check = validatePlacement(probeFen, m.placements, dropOptions);
      if (check.ok) legal.push({ placements: m.placements, fen: check.fen, predicted: 0, pkg: m.pkg });
      if (legal.length >= budgets.verifyCandidates * 2) break;
    }
    if (legal.length > 0) {
      const screenedMirror = await runRounds(legal, legal[0].pkg, 'зеркальный десант');
      if (screenedMirror) {
        const result = await finishRounds(screenedMirror.screened, legal[0].pkg, 'зеркальный десант');
        if (result && result.error <= baseTolerance) return finish(result, baseTolerance);
      }
    }
  }

  // 5. Расширение допуска — не более чем вдвое, и об этом честно пишется в журнале.
  if (best) {
    for (const factor of [1.5, 2]) {
      const widened = Math.round(baseTolerance * factor);
      if (best.error <= widened) {
        ladder.push({ step: 'расширение допуска', result: `принято при ±${widened} сп вместо ±${baseTolerance}` });
        return finish(best, widened, true);
      }
    }
  }

  // 6. Отложить.
  return bail('не нашлось расстановки в пределах допуска', {
    bestError: best ? best.error : null,
    targetDelta,
  });

  function finish(result, toleranceUsed, widened = false) {
    const evalBefore = scoreAt(result.baseline.curve, result.cmp.depth);
    const evalAfter = scoreAt(result.verify.curve, result.cmp.depth);
    return {
      ok: true,
      skipped: false,
      fen: result.fen,
      placements: result.placements.map((p) => ({
        ...p,
        squareName: typeof p.square === 'number' ? squareName(p.square) : p.square,
      })),
      package: { w: result.pkg.w, b: result.pkg.b, id: String(result.pkg.id), label: describePackage(result.pkg) },
      nominalDeltaCp: nominalDelta(result.pkg),
      evalBefore: scoreToCp(evalBefore),
      evalAfter: scoreToCp(evalAfter),
      delta: result.cmp.delta,
      targetDelta,
      error: result.error,
      toleranceUsed,
      toleranceWidened: widened,
      depth: result.cmp.depth,
      character: result.character,
      storyteller: storyteller.id,
      dice: dice || null,
      ladder,
      searchMs: Date.now() - t0,
      budgets,
    };
  }
}

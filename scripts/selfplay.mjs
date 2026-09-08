#!/usr/bin/env node
// Ночной прогон: партии играются сами с собой, десанты идут по расписанию,
// каждый полуход проверяется на инварианты.
//
// Это главный оракул проекта. Юнит-тесты проверяют, что модули делают то, что
// написано; этот прогон проверяет, что механика вообще работает на длинной
// дистанции: держится ли баланс, не заполняется ли доска, не вырождается ли
// партия в ничью по правилу 50 ходов, не течёт ли память.
//
// Флаги: --games=N --minutes=M --seed=... --storyteller=all|mother|bishop|ash
//        --level=1..5 --workers=N --quiet
import fs from 'node:fs';
import path from 'node:path';

import { EnginePool, recommendedPoolSize } from '../src/engine/pool.mjs';
import { readJsonSafe, CURRENT_JSON, SELFPLAY_DIR, ensureDirs } from '../src/shared/paths.mjs';
import { Game } from '../src/game/game.mjs';
import { generateBalancedDrop } from '../src/game/dropGenerator.mjs';
import { chooseComputerMove } from '../src/game/computer.mjs';
import { makeRng } from '../src/game/rng.mjs';
import { rollDice, interpretRoll } from '../src/game/dice.mjs';
import { fenProblems, countMaterial, freeSlots, emptySquares } from '../src/game/fen.mjs';
import { enginePositionProblem } from '../src/game/dropRules.mjs';

const arg = (name, dflt) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const QUIET = process.argv.includes('--quiet');

const GAMES = Number(arg('games', 20));
const MINUTES = Number(arg('minutes', 0));
const SEED = arg('seed', `selfplay-${Date.now()}`);
const WHICH = arg('storyteller', 'all');
const LEVEL = Number(arg('level', 1));
const MAX_PLIES = Number(arg('plies', 160));
// Пул можно урезать: если рядом идёт интерактивная партия, забирать все ядра нельзя.
const WORKERS = Number(arg('workers', 0)) || recommendedPoolSize();

const STORYTELLERS = WHICH === 'all' ? ['mother', 'bishop', 'ash'] : [WHICH];

// ─────────────────────────────────────────── статистика

function percentile(values, p) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
}
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

const stats = {
  games: 0,
  plies: 0,
  dropsAttempted: 0,
  dropsApplied: 0,
  dropsSkipped: 0,
  dropsWidened: 0,
  maxConsecutiveSkips: 0,
  errors: [],
  signedWhite: [],
  signedMover: [],
  times: [],
  emptyOverTime: [],
  maxQueens: 0,
  maxPieces: 0,
  results: {},
  skipReasons: {},
  invariantFailures: [],
  rssSamples: [],
};

/**
 * Инварианты проверяются на КАЖДОМ полуходе, а не в конце партии: иначе
 * непонятно, какой именно ход всё сломал, и разбирать нечего.
 */
function checkInvariants(game, label) {
  const fen = game.fen;
  const problems = fenProblems(fen);
  const unsafe = enginePositionProblem(fen);
  if (unsafe) problems.push(unsafe);

  const { counts, total } = countMaterial(fen);
  if (counts.w.k !== 1 || counts.b.k !== 1) problems.push('королей не по одному');
  if (game.moveLog.length !== game.atoms.filter((a) => a.kind === 'move').length) {
    problems.push('журнал ходов разошёлся с журналом атомов');
  }
  if (game.snapshots.length !== game.atoms.length + 1) problems.push('стек снимков разошёлся с атомами');

  if (total > stats.maxPieces) stats.maxPieces = total;
  const queens = counts.w.q + counts.b.q;
  if (queens > stats.maxQueens) stats.maxQueens = queens;

  if (problems.length) {
    stats.invariantFailures.push({ label, fen, problems });
    return false;
  }
  return true;
}

// ─────────────────────────────────────────── прогон

const engineInfo = readJsonSafe(CURRENT_JSON);
if (!engineInfo) {
  console.error('Движок не установлен. Сначала: npm run setup');
  process.exit(1);
}

ensureDirs();
const outFile = path.join(SELFPLAY_DIR, `selfplay-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`);
const out = fs.createWriteStream(outFile, { flags: 'a' });
const write = (obj) => out.write(`${JSON.stringify(obj)}\n`);

const pool = new EnginePool({
  exePath: engineInfo.path,
  args: engineInfo.args || [],
  size: WORKERS,
  options: { Threads: 1, Hash: 16 },
});
await pool.start();
const { aggregateNps, workers } = await pool.calibrate({ nodes: 200000 });

const started = Date.now();
const deadline = MINUTES > 0 ? started + MINUTES * 60000 : Infinity;

console.log('NOSTROMO GAMBIT · ночной прогон');
console.log(`  движок: ${engineInfo.uciName}, пул ${workers} × ${(aggregateNps / 1e6).toFixed(2)} Mnps`);
console.log(`  партий: ${GAMES}${MINUTES ? `, лимит ${MINUTES} мин` : ''}, сид: ${SEED}`);
console.log(`  журнал: ${outFile}\n`);

write({ kind: 'header', at: new Date().toISOString(), seed: SEED, engine: engineInfo.uciName, aggregateNps, workers });

let stop = false;
process.on('SIGINT', () => {
  console.log('\n  прерывание: досчитываю текущую партию и подвожу итог…');
  stop = true;
});

for (let g = 0; g < GAMES && !stop && Date.now() < deadline; g++) {
  const storytellerId = STORYTELLERS[g % STORYTELLERS.length];
  const seed = `${SEED}:${g}`;
  const rng = makeRng(seed);
  const game = new Game({ seed, settings: { storyteller: storytellerId, autoDropEveryFullMoves: null } });
  let consecutiveSkips = 0;

  for (let ply = 0; ply < MAX_PLIES && !game.gameOver; ply++) {
    // ── десант: по расписанию либо на случайно потраченный жетон
    const wantDice = game.dice[game.turn] > 0 && rng.float() < 0.04;
    if ((game.autoDropDue || wantDice) && !game.gameOver) {
      const roll = wantDice ? interpretRoll(rollDice(rng), game.turn) : null;
      if (roll) game.spendDiceRoll(game.turn);

      const fenBefore = game.fen;
      stats.dropsAttempted += 1;
      const t0 = Date.now();
      let drop;
      try {
        drop = await generateBalancedDrop(pool, fenBefore, {
          rng,
          storytellerId,
          dice: roll,
          ledgerCp: game.ledgerCp,
          aggregateNps,
        });
      } catch (err) {
        drop = { ok: false, skipped: true, reason: `исключение: ${err.message}` };
      }
      stats.times.push(Date.now() - t0);

      if (drop.ok) {
        stats.dropsApplied += 1;
        if (drop.toleranceWidened) stats.dropsWidened += 1;
        stats.errors.push(drop.error);
        stats.signedWhite.push(drop.delta - drop.targetDelta);
        // Тот же перекос, но от лица стороны к ходу: систематическая ошибка
        // темпа видна только здесь и нигде больше.
        const mover = game.turn === 'w' ? 1 : -1;
        stats.signedMover.push((drop.delta - drop.targetDelta) * mover);
        consecutiveSkips = 0;
        game.applyDrop(drop);
        write({
          kind: 'drop',
          game: g,
          storytellerId,
          ply,
          fenBefore,
          fenAfter: drop.fen,
          delta: drop.delta,
          targetDelta: drop.targetDelta,
          error: drop.error,
          widened: drop.toleranceWidened,
          ms: drop.searchMs,
          pkg: drop.package?.label,
          placements: drop.placements.map((p) => `${p.color}${p.type}${p.squareName}`),
          dice: roll,
        });
      } else {
        stats.dropsSkipped += 1;
        consecutiveSkips += 1;
        if (consecutiveSkips > stats.maxConsecutiveSkips) stats.maxConsecutiveSkips = consecutiveSkips;
        stats.skipReasons[drop.reason] = (stats.skipReasons[drop.reason] || 0) + 1;
        if (roll) game.refundDiceRoll(roll.side);
        game.noteSkippedDrop(drop.reason);
        write({ kind: 'skip', game: g, ply, reason: drop.reason });
      }

      if (!checkInvariants(game, `партия ${g}, полуход ${ply}, после десанта`)) {
        console.error(`\n  ИНВАРИАНТ НАРУШЕН после десанта: ${game.fen}`);
        stop = true;
        break;
      }
      if (game.gameOver) break;
    }

    // ── ход движка за обе стороны
    let move;
    try {
      move = await chooseComputerMove(pool, game.fen, { level: LEVEL, rng });
    } catch (err) {
      write({ kind: 'moveError', game: g, ply, error: err.message });
      break;
    }
    if (!move) break;
    const r = game.move(move);
    if (!r.ok) {
      write({ kind: 'illegalMove', game: g, ply, move, reason: r.code });
      break;
    }
    stats.plies += 1;
    stats.emptyOverTime.push({ ply: game.moveLog.length, empty: emptySquares(game.fen).length, slots: freeSlots(game.fen) });

    if (!checkInvariants(game, `партия ${g}, полуход ${ply}, после хода`)) {
      console.error(`\n  ИНВАРИАНТ НАРУШЕН после хода: ${game.fen}`);
      stop = true;
      break;
    }
  }

  stats.games += 1;
  const result = game.gameOver ? game.gameOver.reason : 'лимит ходов';
  stats.results[result] = (stats.results[result] || 0) + 1;
  stats.rssSamples.push(Math.round(process.memoryUsage().rss / 1e6));

  write({
    kind: 'game',
    game: g,
    storytellerId,
    seed,
    plies: game.moveLog.length,
    drops: game.dropLog.length,
    result,
    finalFen: game.fen,
    ledgerCp: game.ledgerCp,
  });

  if (!QUIET) {
    const applied = stats.dropsApplied;
    const rate = stats.dropsAttempted ? ((applied / stats.dropsAttempted) * 100).toFixed(0) : '—';
    process.stdout.write(
      `\r  партия ${g + 1}/${GAMES} · ходов ${game.moveLog.length} · десантов ${game.dropLog.length} · ` +
        `принято ${rate}% · p50 |ошибка| ${percentile(stats.errors, 50) ?? '—'} сп   `,
    );
  }
}

// ─────────────────────────────────────────── итог

const totalMin = ((Date.now() - started) / 60000).toFixed(1);
const applied = stats.dropsApplied;
const clean = applied - stats.dropsWidened;

const emptyEarly = mean(stats.emptyOverTime.filter((e) => e.ply < 30).map((e) => e.empty));
const emptyLate = mean(stats.emptyOverTime.filter((e) => e.ply >= 60).map((e) => e.empty));

const summary = {
  kind: 'summary',
  minutes: Number(totalMin),
  games: stats.games,
  plies: stats.plies,
  dropsAttempted: stats.dropsAttempted,
  dropsApplied: applied,
  dropsClean: clean,
  dropsWidened: stats.dropsWidened,
  dropsSkipped: stats.dropsSkipped,
  maxConsecutiveSkips: stats.maxConsecutiveSkips,
  errorP50: percentile(stats.errors, 50),
  errorP90: percentile(stats.errors, 90),
  errorMax: stats.errors.length ? Math.max(...stats.errors) : null,
  signedMeanWhite: Number((mean(stats.signedWhite) ?? 0).toFixed(2)),
  signedMeanMover: Number((mean(stats.signedMover) ?? 0).toFixed(2)),
  timeP50: percentile(stats.times, 50),
  timeP95: percentile(stats.times, 95),
  timeMax: stats.times.length ? Math.max(...stats.times) : null,
  maxPieces: stats.maxPieces,
  maxQueens: stats.maxQueens,
  emptyEarly: emptyEarly === null ? null : Number(emptyEarly.toFixed(1)),
  emptyLate: emptyLate === null ? null : Number(emptyLate.toFixed(1)),
  results: stats.results,
  skipReasons: stats.skipReasons,
  invariantFailures: stats.invariantFailures.length,
  rssFirst: stats.rssSamples[0],
  rssLast: stats.rssSamples[stats.rssSamples.length - 1],
};
write(summary);

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(0)}%` : '—');

console.log(`\n\n══════ ИТОГ ЗА ${totalMin} МИН ══════`);
console.log(`партий ${stats.games}, полуходов ${stats.plies}`);
console.log(`\nДЕСАНТ`);
console.log(`  попыток              ${stats.dropsAttempted}`);
console.log(`  принято              ${applied} (${pct(applied, stats.dropsAttempted)})`);
console.log(`  из них без расширения ${clean} (${pct(clean, stats.dropsAttempted)})`);
console.log(`  отложено             ${stats.dropsSkipped} (${pct(stats.dropsSkipped, stats.dropsAttempted)})`);
console.log(`  отказов подряд, макс ${stats.maxConsecutiveSkips}`);
console.log(`\nТОЧНОСТЬ БАЛАНСА`);
console.log(`  |ошибка| сп: p50=${summary.errorP50} p90=${summary.errorP90} max=${summary.errorMax}`);
console.log(`  знаковое среднее (POV белых)        ${summary.signedMeanWhite} сп   [порог ±5]`);
console.log(`  знаковое среднее (POV к ходу)       ${summary.signedMeanMover} сп   [порог ±8]`);
console.log(`\nВРЕМЯ ПОИСКА, мс: p50=${summary.timeP50} p95=${summary.timeP95} max=${summary.timeMax}`);
console.log(`\nДОСКА`);
console.log(`  максимум фигур       ${stats.maxPieces} / 32`);
console.log(`  максимум ферзей      ${stats.maxQueens}`);
console.log(`  пустых полей: до 30-го хода ${summary.emptyEarly ?? "нет данных"}, после 60-го ${summary.emptyLate ?? "нет данных"}`);
console.log(`\nИСХОДЫ: ${Object.entries(stats.results).map(([k, v]) => `${k} ${v}`).join(', ')}`);
if (Object.keys(stats.skipReasons).length) {
  console.log(`\nПРИЧИНЫ ОТКАЗА:`);
  for (const [reason, n] of Object.entries(stats.skipReasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n}×  ${reason}`);
  }
}
console.log(`\nПАМЯТЬ RSS: ${summary.rssFirst} → ${summary.rssLast} МБ`);
console.log(`НАРУШЕНИЙ ИНВАРИАНТОВ: ${stats.invariantFailures.length}`);
for (const f of stats.invariantFailures.slice(0, 5)) {
  console.log(`  ${f.label}: ${f.problems.join('; ')}`);
  console.log(`    ${f.fen}`);
}
console.log(`\nподробности: ${outFile}`);

out.end();
await pool.dispose();

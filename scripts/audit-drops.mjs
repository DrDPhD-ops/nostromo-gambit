#!/usr/bin/env node
// Независимая переоценка уже применённых десантов.
//
// Во время партии дельта измеряется тем бюджетом, который укладывается в пару
// секунд. Этот скрипт берёт записанные пары «до/после» и пересчитывает их
// НАМНОГО глубже, без спешки. Так проверяется не «сошёлся ли поиск сам с собой»,
// а «действительно ли позиция осталась равной».
//
// Это последняя инстанция: если здесь дельты разъезжаются, значит бюджеты поиска
// в игре слишком малы, каким бы согласованным ни выглядел результат внутри партии.
//
// Флаги: --file=путь.ndjson (по умолчанию последний) --nodes=N --limit=N
import fs from 'node:fs';
import path from 'node:path';

import { EnginePool, recommendedPoolSize } from '../src/engine/pool.mjs';
import { readJsonSafe, CURRENT_JSON, SELFPLAY_DIR } from '../src/shared/paths.mjs';
import { normalizeForComparison } from '../src/game/fen.mjs';
import { scoreAt, scoreToCp, isMate, commonDepth } from '../src/engine/evaluate.mjs';

const arg = (name, dflt) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const NODES = Number(arg('nodes', 3_000_000));
const LIMIT = Number(arg('limit', 40));
/** Бюджет, сопоставимый с игровым: им меряется контрольный шум оценки. */
const SHALLOW = Number(arg('shallow', 300000));

function latestNdjson() {
  const files = fs
    .readdirSync(SELFPLAY_DIR)
    .filter((f) => f.endsWith('.ndjson'))
    .map((f) => ({ f: path.join(SELFPLAY_DIR, f), t: fs.statSync(path.join(SELFPLAY_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0] ? files[0].f : null;
}

const file = arg('file', null) || latestNdjson();
if (!file || !fs.existsSync(file)) {
  console.error('Нет журнала ночного прогона. Сначала: npm run selfplay');
  process.exit(1);
}

const engineInfo = readJsonSafe(CURRENT_JSON);
if (!engineInfo) {
  console.error('Движок не установлен. Сначала: npm run setup');
  process.exit(1);
}

const drops = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter((r) => r && r.kind === 'drop');

if (drops.length === 0) {
  console.error(`В журнале ${file} нет применённых десантов.`);
  process.exit(1);
}

// Берём равномерную выборку по всему журналу, а не первые N: начало партий
// систематически отличается от их середины.
const step = Math.max(1, Math.floor(drops.length / LIMIT));
const sample = drops.filter((_, i) => i % step === 0).slice(0, LIMIT);

console.log('NOSTROMO GAMBIT · независимая переоценка десантов');
console.log(`  журнал: ${path.basename(file)} (${drops.length} десантов, берём ${sample.length})`);
console.log(`  бюджет переоценки: ${(NODES / 1e6).toFixed(1)}M узлов на позицию\n`);

const pool = new EnginePool({
  exePath: engineInfo.path,
  args: engineInfo.args || [],
  size: recommendedPoolSize(),
  options: { Threads: 1, Hash: 64 },
});
await pool.start();

const results = [];
// Контроль: насколько расходятся мелкая и глубокая оценки ОДНОЙ И ТОЙ ЖЕ позиции,
// без всякого десанта. Это шумовой пол — цифру ошибки десанта не с чем сравнивать,
// пока не известно, сколько оценка гуляет сама по себе при смене бюджета.
const noise = [];
let done = 0;

for (const d of sample) {
  const before = normalizeForComparison(d.fenBefore);
  const after = normalizeForComparison(d.fenAfter);
  const [a, b, shallow] = await Promise.all([
    pool.analyse({ fen: before, nodes: NODES, newGame: true }),
    pool.analyse({ fen: after, nodes: NODES, newGame: true }),
    pool.analyse({ fen: before, nodes: SHALLOW, newGame: true }),
  ]);
  // Каждая оценка берётся на СВОЕЙ максимальной глубине: сравниваем именно то,
  // что каждый бюджет сообщил бы как свой ответ, а не приведённые к общей глубине.
  const deepSelf = scoreAt(a.curve, a.curve.maxDepth);
  const shallowSelf = scoreAt(shallow.curve, shallow.curve.maxDepth);
  if (deepSelf && shallowSelf && !isMate(deepSelf) && !isMate(shallowSelf)) {
    noise.push(Math.abs(scoreToCp(deepSelf) - scoreToCp(shallowSelf)));
  }
  const depth = commonDepth([a.curve, b.curve]);
  const e0 = scoreAt(a.curve, depth);
  const e1 = scoreAt(b.curve, depth);
  done += 1;
  process.stdout.write(`\r  переоценено ${done}/${sample.length}   `);
  if (!e0 || !e1 || isMate(e0) || isMate(e1)) continue;

  const trueDelta = scoreToCp(e1) - scoreToCp(e0);
  results.push({
    reported: d.delta,
    target: d.targetDelta,
    trueDelta,
    trueError: Math.abs(trueDelta - d.targetDelta),
    drift: Math.abs(trueDelta - d.delta),
    depth,
    widened: d.widened,
    storyteller: d.storytellerId,
  });
}

await pool.dispose();

const pct = (arr, q) => {
  const s = [...arr].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))] : null;
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

const trueErrors = results.map((r) => r.trueError);
const drifts = results.map((r) => r.drift);
const signed = results.map((r) => r.trueDelta - r.target);

console.log(`\n\n══════ ПЕРЕОЦЕНКА НА ${(NODES / 1e6).toFixed(1)}M УЗЛОВ ══════`);
console.log(`позиций переоценено: ${results.length} из ${sample.length}`);
console.log(`средняя глубина сравнения: ${Math.round(mean(results.map((r) => r.depth)))}\n`);

console.log('ИСТИННАЯ ОШИБКА |Δ − цель|, сп');
console.log(`  p50=${pct(trueErrors, 0.5)}  p90=${pct(trueErrors, 0.9)}  p99=${pct(trueErrors, 0.99)}  max=${Math.max(...trueErrors)}`);
console.log(`  пороги плана:  p50 ≤ 20   p90 ≤ 60   p99 ≤ 120\n`);

// Знаковое среднее без оценки разброса интерпретировать нельзя: при большом
// разбросе и небольшой выборке оно гуляет само по себе. Печатаем две стандартные
// ошибки, чтобы было видно, отличается ли смещение от нуля или это шум.
const meanSigned = mean(signed);
const sd = Math.sqrt(mean(signed.map((x) => (x - meanSigned) ** 2)));
const twoSe = 2 * (sd / Math.sqrt(Math.max(1, signed.length)));
console.log('ЗНАКОВОЕ СРЕДНЕЕ (POV белых)');
console.log(`  ${meanSigned.toFixed(1)} ± ${twoSe.toFixed(1)} сп   (n=${signed.length}, порог ±5)`);
console.log(
  Math.abs(meanSigned) > twoSe
    ? '  выходит за две стандартные ошибки — похоже на систематическое смещение\n'
    : '  в пределах двух стандартных ошибок — от нуля неотличимо\n',
);

console.log('РАСХОЖДЕНИЕ С ИГРОВЫМ ЗАМЕРОМ |Δ_глубокая − Δ_игровая|, сп');
console.log(`  p50=${pct(drifts, 0.5)}  p90=${pct(drifts, 0.9)}  max=${Math.max(...drifts)}\n`);

console.log('КОНТРОЛЬ: шум самой оценки, без всякого десанта');
console.log(`  одна и та же позиция на ${(SHALLOW / 1e3).toFixed(0)}k и на ${(NODES / 1e6).toFixed(1)}M узлов`);
console.log(`  расходится на: p50=${pct(noise, 0.5)}  p90=${pct(noise, 0.9)}  max=${Math.max(...noise)} сп`);
console.log('  ниже этой величины ошибка десанта опуститься не может в принципе:');
console.log('  это не качество подбора, а то, насколько оценка зависит от бюджета\n');

console.log('ПО ПЛАНИРОВЩИКАМ (ожидаемый порядок: МАТЬ < БИШОП < ЭШ —');
console.log(' МАТЬ выбирает устойчивые расстановки, ЭШ намеренно волатильные)');
const byTeller = {};
for (const r of results) (byTeller[r.storyteller] ||= []).push(r);
for (const [id, rs] of Object.entries(byTeller)) {
  const errs = rs.map((r) => r.trueError);
  const sgn = rs.map((r) => r.trueDelta - r.target);
  console.log(
    `  ${id.padEnd(8)} n=${String(rs.length).padStart(3)}  p50=${String(pct(errs, 0.5)).padStart(4)}  ` +
      `p90=${String(pct(errs, 0.9)).padStart(4)}  знаковое ${mean(sgn).toFixed(1)}`,
  );
}

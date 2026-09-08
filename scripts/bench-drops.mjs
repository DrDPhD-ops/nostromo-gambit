#!/usr/bin/env node
// Замер качества и скорости десанта на настоящем движке.
//
// Это инструмент приёмочных ворот этапа «ядро»: единственное число, которое решает,
// существует ли игра, — доля десантов, уложившихся в допуск, и время поиска.
//
// Флаги: --positions=N --storyteller=all|mother|bishop|ash --seed=... --json=путь
import { EnginePool, recommendedPoolSize } from '../src/engine/pool.mjs';
import { readJsonSafe, CURRENT_JSON, SELFPLAY_DIR, ensureDirs } from '../src/shared/paths.mjs';
import { generateBalancedDrop } from '../src/game/dropGenerator.mjs';
import { makeRng } from '../src/game/rng.mjs';
import { buildCorpus } from './corpus.mjs';
import { countMaterial } from '../src/game/fen.mjs';
import { UciEngine } from '../src/engine/uci.mjs';
import { enginePositionProblem } from '../src/game/dropRules.mjs';
import fs from 'node:fs';
import path from 'node:path';

const arg = (name, dflt) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const POSITIONS = Number(arg('positions', 18));
const SEED = arg('seed', 'bench-1');
const WHICH = arg('storyteller', 'all');
const JSON_OUT = arg('json', null);

function percentile(values, p) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
}

const engineInfo = readJsonSafe(CURRENT_JSON);
if (!engineInfo) {
  console.error('Движок не установлен. Сначала: npm run setup');
  process.exit(1);
}

const corpus = buildCorpus({ seed: SEED, count: POSITIONS });
console.log(`NOSTROMO GAMBIT · замер десанта`);
console.log(`  движок: ${engineInfo.uciName} (${engineInfo.kind}), одиночная скорость ${(engineInfo.nps / 1e6).toFixed(2)} Mnps`);
console.log(`  позиций: ${corpus.length}, сид: ${SEED}`);

const DEBUG = process.argv.includes('--debug');

/**
 * В отладочном режиме каждый движок докладывает свой stderr и последнюю отправленную
 * позицию перед смертью. Без этого падение движка выглядит как «ENGINE_CRASHED»
 * без единой подсказки о причине.
 */
let engineTag = 0;
class DebugEngine extends UciEngine {
  constructor(o) {
    super(o);
    this.tag = ++engineTag;
    this.lastPosition = null;
    this.on('command', (c) => {
      if (c.startsWith('position')) this.lastPosition = c.replace(/^position (fen )?/, '');
    });
    this.on('stderr', (d) => console.log(`\n  [движок ${this.tag}] stderr: ${String(d).trim().slice(0, 300)}`));
    this.on('died', (e) => {
      console.log(`\n  [движок ${this.tag}] УМЕР: ${e.message}`);
      if (this.lastPosition) {
        console.log(`      последняя позиция: ${this.lastPosition}`);
        console.log(`      фигур=${countMaterial(this.lastPosition).total}, наша проверка: ${enginePositionProblem(this.lastPosition) || 'в порядке'}`);
      }
    });
  }
}

const pool = new EnginePool({
  createEngine: DEBUG
    ? () => new DebugEngine({ exePath: engineInfo.path, args: engineInfo.args || [], options: { Threads: 1, Hash: 16 } })
    : null,
  exePath: engineInfo.path,
  args: engineInfo.args || [],
  size: recommendedPoolSize(),
  options: { Threads: 1, Hash: 16 },
});
await pool.start();
const { aggregateNps, workers } = await pool.calibrate({ nodes: 250000 });
console.log(`  пул: ${workers} воркеров, совокупно ${(aggregateNps / 1e6).toFixed(2)} Mnps\n`);

const storytellers = WHICH === 'all' ? ['mother', 'bishop', 'ash'] : [WHICH];
const records = [];

for (const storytellerId of storytellers) {
  const stats = { ok: 0, widened: 0, skipped: 0, errors: [], times: [], deltas: [] };
  for (let i = 0; i < corpus.length; i++) {
    const entry = corpus[i];
    const rng = makeRng(`${SEED}:${storytellerId}:${i}`);
    const t0 = Date.now();
    let r;
    try {
      r = await generateBalancedDrop(pool, entry.fen, { rng, storytellerId, aggregateNps });
    } catch (err) {
      console.log(`  ${storytellerId} #${i}: ИСКЛЮЧЕНИЕ ${err.code || ''} ${err.message}`);
      continue;
    }
    const ms = Date.now() - t0;
    stats.times.push(ms);

    if (r.ok) {
      stats.ok += 1;
      if (r.toleranceWidened) stats.widened += 1;
      stats.errors.push(r.error);
      stats.deltas.push(r.delta - r.targetDelta);
      records.push({
        storytellerId,
        index: i,
        label: entry.label,
        fenBefore: entry.fen,
        fenAfter: r.fen,
        delta: r.delta,
        targetDelta: r.targetDelta,
        error: r.error,
        widened: r.toleranceWidened,
        depth: r.depth,
        ms,
        placements: r.placements.map((p) => `${p.color}${p.type}${p.squareName}`),
        pkg: r.package.label,
        character: r.character,
      });
    } else {
      stats.skipped += 1;
      records.push({ storytellerId, index: i, label: entry.label, skipped: true, reason: r.reason, ms });
    }
    process.stdout.write(
      `\r  ${storytellerId}: ${i + 1}/${corpus.length}  принято ${stats.ok}, отложено ${stats.skipped}   `,
    );
  }

  const total = corpus.length;
  const clean = stats.ok - stats.widened;
  console.log(`\r  ${storytellerId.toUpperCase().padEnd(8)} принято ${stats.ok}/${total} ` +
    `(без расширения ${clean}), отложено ${stats.skipped}`);
  console.log(`      |ошибка| сп: p50=${percentile(stats.errors, 50)} p90=${percentile(stats.errors, 90)} max=${Math.max(0, ...stats.errors)}`);
  const signed = stats.deltas.reduce((s, d) => s + d, 0) / Math.max(1, stats.deltas.length);
  console.log(`      знаковое среднее Δ: ${signed.toFixed(1)} сп  (проверка на систематический перекос)`);
  console.log(`      время, мс: p50=${percentile(stats.times, 50)} p95=${percentile(stats.times, 95)} max=${Math.max(...stats.times)}\n`);
}

if (JSON_OUT) {
  ensureDirs();
  const out = path.isAbsolute(JSON_OUT) ? JSON_OUT : path.join(SELFPLAY_DIR, JSON_OUT);
  fs.writeFileSync(out, JSON.stringify({ engineInfo, aggregateNps, records }, null, 2), 'utf8');
  console.log(`подробности: ${out}`);
}

await pool.dispose();

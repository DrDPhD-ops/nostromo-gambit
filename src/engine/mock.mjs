// Детерминированный движок внутри процесса: без spawn, без ожиданий.
//
// Существует ради одного правила: юнит-ярус обязан укладываться в пару секунд,
// иначе его перестанут гонять. Всё, чему нужна просто «какая-то» оценка, берёт его;
// настоящий Stockfish остаётся только там, где он что-то доказывает — проволочный
// протокол, жизненный цикл процессов, сироты и реальное качество десанта.
import { EventEmitter } from 'node:events';
import { createCurve, feedCurve, parseInfoLine, scoreAt, depthSpread } from './evaluate.mjs';

const VALUE = { p: 100, n: 305, b: 333, r: 563, q: 950, k: 0 };

/** Небольшая премия за центр — чтобы поле размещения хоть на что-то влияло. */
function centralization(fileIdx, rankIdx) {
  const df = 3.5 - Math.abs(fileIdx - 3.5);
  const dr = 3.5 - Math.abs(rankIdx - 3.5);
  return Math.round((df + dr) * 3);
}

function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Оценка позиции в POV белых: материал + центр + маленькое детерминированное дрожание.
 * Дрожание нужно, чтобы кандидаты не были сплошь одинаковыми и сортировка что-то значила.
 */
export function mockEvaluateFen(fen) {
  const [board = '', turn = 'w'] = String(fen).split(/\s+/);
  let cp = 0;
  const ranks = board.split('/');
  for (let r = 0; r < ranks.length; r++) {
    let f = 0;
    for (const ch of ranks[r]) {
      if (/\d/.test(ch)) {
        f += Number(ch);
        continue;
      }
      const lower = ch.toLowerCase();
      const v = VALUE[lower] ?? 0;
      const sign = ch === lower ? -1 : 1;
      cp += sign * (v + (lower === 'k' ? 0 : centralization(f, 7 - r)));
      f += 1;
    }
  }
  const jitter = (hash32(String(fen)) % 13) - 6;
  return cp + jitter + (turn === 'w' ? 8 : -8); // право хода немного стоит
}

export class MockEngine extends EventEmitter {
  #disposed = false;
  #busy = false;

  /**
   * @param {object} opts
   * @param {number} opts.delayMs        искусственная задержка на задачу
   * @param {Map<string,number>} opts.overrides  точные оценки для конкретных FEN
   */
  constructor({ delayMs = 0, overrides = null, label = 'mock' } = {}) {
    super();
    this.delayMs = delayMs;
    this.overrides = overrides || new Map();
    this.label = label;
    this.id = 'MockFish 1.0';
    this.pid = null;
    this.calls = { analyse: 0, staticEval: 0 };
  }

  get alive() {
    return !this.#disposed;
  }

  get busy() {
    return this.#busy;
  }

  async start() {
    return this;
  }

  async warmup() {}

  async isReady() {
    return true;
  }

  async setMultiPv() {}

  #wait() {
    return this.delayMs ? new Promise((r) => setTimeout(r, this.delayMs)) : Promise.resolve();
  }

  #cpFor(fen) {
    if (this.overrides.has(fen)) return this.overrides.get(fen);
    return mockEvaluateFen(fen);
  }

  async analyse({ fen, nodes = 100000, multipv = 1, signal = null } = {}) {
    if (this.#disposed) throw new Error('ENGINE_SHUTDOWN');
    if (this.#busy) throw new Error('ENGINE_BUSY');
    this.#busy = true;
    this.calls.analyse += 1;
    try {
      await this.#wait();
      if (signal && signal.aborted) throw new Error('ENGINE_ABORTED');

      const sideToMove = fen === 'startpos' ? 'w' : fen.split(/\s+/)[1] === 'b' ? 'b' : 'w';
      const whiteCp = this.#cpFor(fen);
      // Оценка в UCI — от лица стороны к ходу; кривая приведёт её обратно к белым.
      const povCp = sideToMove === 'w' ? whiteCp : -whiteCp;
      const maxDepth = Math.max(4, Math.min(28, Math.round(Math.log2(Math.max(nodes, 1024)) * 1.5)));

      const curve = createCurve();
      const seed = hash32(String(fen));
      for (let d = 1; d <= maxDepth; d++) {
        // Сходимость к финальной оценке: мелкие глубины дрожат сильнее.
        const noise = d >= maxDepth - 1 ? 0 : (((seed >> d) % 21) - 10) * Math.max(1, maxDepth - d);
        feedCurve(curve, parseInfoLine(`info depth ${d} score cp ${povCp + noise} nodes ${nodes} pv e2e4`), sideToMove);
      }

      const perPv = new Map([[1, { depth: maxDepth, score: { kind: 'cp', value: povCp }, pv: ['e2e4'] }]]);
      if (multipv >= 2) {
        const gap = 20 + (seed % 180); // разрыв до второго хода — мера «единственности»
        perPv.set(2, { depth: maxDepth, score: { kind: 'cp', value: povCp - gap }, pv: ['d2d4'] });
      }

      return {
        fen,
        nodes,
        sideToMove,
        curve,
        depth: maxDepth,
        score: scoreAt(curve, maxDepth),
        spread: depthSpread(curve, maxDepth),
        pv: ['e2e4'],
        best: 'e2e4',
        multipv: perPv,
        infoLines: maxDepth,
      };
    } finally {
      this.#busy = false;
    }
  }

  async staticEval(fen) {
    if (this.#disposed) throw new Error('ENGINE_SHUTDOWN');
    this.calls.staticEval += 1;
    await this.#wait();
    return this.#cpFor(fen);
  }

  async debugFen(fen) {
    return fen;
  }

  async dispose() {
    this.#disposed = true;
  }
}

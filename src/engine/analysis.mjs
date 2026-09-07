// Отдельный движок для шкалы оценки.
//
// Он никогда не входит в пул. Причина в протоколе: писать `position` во время
// идущего поиска нельзя — движок останется считать устаревшую позицию, и шкала
// будет показывать то, чего на доске уже нет. Правильная последовательность всегда
// одна: `stop` -> дождаться `bestmove` -> переставить.
//
// Автомат состояний:  ПОКОЙ -> ПОИСК -> ОСТАНОВКА -> ПОИСК(отложенная позиция)
import { EventEmitter } from 'node:events';
import { UciEngine } from './uci.mjs';
import { scoreAt, scoreToCp } from './evaluate.mjs';

const IDLE = 'idle';
const SEARCHING = 'searching';
const STOPPING = 'stopping';

export class AnalysisEngine extends EventEmitter {
  #engine = null;
  #state = IDLE;
  #pendingFen = null;
  #currentFen = null;
  #paused = false;
  #lastEmit = 0;
  #abort = null;

  constructor({ exePath, args = [], options = {}, nodes = 900000, throttleMs = 250 } = {}) {
    super();
    this.exePath = exePath;
    this.args = args;
    this.options = { Threads: 1, Hash: 32, ...options };
    this.nodes = nodes;
    this.throttleMs = throttleMs;
  }

  get healthy() {
    return Boolean(this.#engine && this.#engine.alive);
  }

  async start() {
    this.#engine = new UciEngine({ exePath: this.exePath, args: this.args, options: this.options, label: 'analysis' });
    this.#engine.on('died', () => {
      this.#state = IDLE;
      this.emit('died');
    });
    await this.#engine.start();
    return this;
  }

  /**
   * Поставить новую позицию. Частые смены схлопываются: пять вызовов за десять
   * миллисекунд дадут ровно один поиск — для последней позиции.
   */
  setPosition(fen) {
    this.#pendingFen = fen;
    if (this.#paused || !this.healthy) return;
    if (this.#state === IDLE) this.#pump();
    else if (this.#state === SEARCHING) this.#requestStop();
  }

  /** На время поиска десанта анализ уступает ядра — там они нужнее. */
  async pause() {
    this.#paused = true;
    if (this.#state === SEARCHING) this.#requestStop();
  }

  resume(fen = null) {
    this.#paused = false;
    if (fen) this.#pendingFen = fen;
    if (this.#state === IDLE) this.#pump();
  }

  #requestStop() {
    this.#state = STOPPING;
    // Останов идёт ТОЛЬКО через сигнал отмены: UciEngine по нему сам пошлёт `stop`
    // и дождётся `bestmove`, не рассинхронизировав протокол. Писать `stop`
    // в обход задачи нельзя — недополученный `bestmove` испортит все следующие.
    try {
      this.#abort?.abort();
    } catch {
      /* движок мог умереть — это заметит обработчик died */
    }
  }

  async #pump() {
    if (this.#paused || !this.healthy) return;
    const fen = this.#pendingFen;
    this.#pendingFen = null;
    if (!fen) {
      this.#state = IDLE;
      return;
    }

    this.#state = SEARCHING;
    this.#currentFen = fen;
    this.#abort = new AbortController();

    try {
      const result = await this.#engine.analyse({
        fen,
        nodes: this.nodes,
        newGame: false,
        timeoutMs: 60000,
        signal: this.#abort.signal,
      });
      this.#publish(fen, result);
    } catch (err) {
      // Отмена — штатный путь, а не ошибка: позиция сменилась быстрее, чем мы досчитали.
      if (err && err.code !== 'ENGINE_ABORTED') this.emit('error', err);
    } finally {
      this.#state = IDLE;
      if (this.#pendingFen && !this.#paused) this.#pump();
    }
  }

  #publish(fen, result) {
    const score = scoreAt(result.curve, result.curve.maxDepth);
    if (!score) return;
    const now = Date.now();
    if (now - this.#lastEmit < this.throttleMs) return;
    this.#lastEmit = now;
    this.emit('eval', {
      fen,
      cp: score.kind === 'cp' ? score.value : null,
      mate: score.kind === 'mate' ? score.value : null,
      scoreCp: scoreToCp(score),
      depth: result.curve.maxDepth,
      pv: result.pv ? result.pv.slice(0, 6) : [],
    });
  }

  async dispose() {
    this.#paused = true;
    this.#abort?.abort();
    if (this.#engine) await this.#engine.dispose();
    this.#engine = null;
  }
}

// Пул движков: N процессов, очередь с приоритетом, перезапуск после падений.
//
// Пул — единственное место, где гарантируется эксклюзивность: UciEngine намеренно
// не умеет очередей и отвергает вторую задачу. Если этот инвариант нарушить,
// протокол UCI рассинхронизируется тихо и результаты станут мусором без единой ошибки.
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { UciEngine, EngineError, ERR } from './uci.mjs';

const BACKOFF_MS = [200, 400, 800, 1600, 5000];
const BREAKER_WINDOW_MS = 60000;
const BREAKER_FAILURES = 5;

/**
 * Сколько поисковых воркеров имеет смысл держать.
 * Замер на i5-10300H (4 ядра / 8 потоков): 1 воркер — 0.58 Mnps, 2 — 1.04,
 * 4 — 1.56, 6 — 1.92. Масштабирование сильно сублинейное, поэтому забирать
 * все логические ядра бессмысленно: аналитический движок и браузер тоже должны жить.
 */
export function recommendedPoolSize(logicalCores = os.cpus().length) {
  return Math.max(1, Math.min(5, logicalCores - 3));
}

class Slot {
  constructor(index, factory) {
    this.index = index;
    this.factory = factory;
    this.engine = null;
    this.failures = [];
    this.disabled = false;
    this.starting = null;
    // Занятость держит САМ пул, а не движок.
    // Полагаться на engine.busy нельзя: он поднимается только внутри вызова движка,
    // поэтому задача, которая делает что-то ещё (пауза, несколько последовательных
    // вызовов, чистая арифметика), оставляла бы слот «свободным» и пул выдал бы
    // один и тот же процесс двум задачам — а UCI это рассинхронизирует молча.
    this.busy = false;
  }

  get available() {
    return !this.disabled && !this.busy && this.engine && this.engine.alive;
  }

  noteFailure() {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < BREAKER_WINDOW_MS);
    this.failures.push(now);
    if (this.failures.length >= BREAKER_FAILURES) this.disabled = true;
    return this.disabled;
  }
}

export class EnginePool extends EventEmitter {
  #slots = [];
  #queue = [];
  #disposed = false;
  #running = 0;
  #peakConcurrency = 0;

  /**
   * @param {object} opts
   * @param {Function} opts.createEngine  фабрика движка (для тестов подсовывается MockEngine)
   * @param {string}   opts.exePath       путь к бинарю, если фабрика не задана
   */
  constructor({ createEngine = null, exePath = null, args = [], options = {}, size = null, warmupNodes = 150000 } = {}) {
    super();
    this.size = size || recommendedPoolSize();
    this.warmupNodes = warmupNodes;
    this.createEngine =
      createEngine ||
      (() => {
        if (!exePath) throw new Error('EnginePool: нужен либо createEngine, либо exePath');
        return new UciEngine({ exePath, args, options });
      });
  }

  get healthy() {
    return this.#slots.some((s) => !s.disabled && s.engine && s.engine.alive);
  }

  get liveCount() {
    return this.#slots.filter((s) => s.engine && s.engine.alive).length;
  }

  get peakConcurrency() {
    return this.#peakConcurrency;
  }

  get queueLength() {
    return this.#queue.length;
  }

  async start() {
    this.#slots = Array.from({ length: this.size }, (_, i) => new Slot(i, this.createEngine));
    await Promise.all(this.#slots.map((s) => this.#spawnSlot(s)));
    if (!this.healthy) throw new Error('EnginePool: ни один движок не поднялся');
    this.emit('health', { healthy: this.healthy, live: this.liveCount });
    return this;
  }

  async #spawnSlot(slot) {
    if (this.#disposed || slot.disabled) return;
    slot.starting = (async () => {
      const engine = slot.factory();
      engine.on('died', () => this.#onSlotDied(slot));
      await engine.start();
      if (this.warmupNodes && engine.warmup) await engine.warmup({ nodes: this.warmupNodes });
      slot.engine = engine;
    })();
    try {
      await slot.starting;
    } catch (err) {
      slot.engine = null;
      const dead = slot.noteFailure();
      this.emit('slotError', { index: slot.index, error: err, disabled: dead });
    } finally {
      slot.starting = null;
    }
  }

  #onSlotDied(slot) {
    if (this.#disposed) return;
    const disabled = slot.noteFailure();
    const attempt = Math.min(slot.failures.length - 1, BACKOFF_MS.length - 1);
    slot.engine = null;
    this.emit('health', { healthy: this.healthy, live: this.liveCount });
    if (disabled) {
      this.emit('slotDisabled', { index: slot.index });
      this.#pump();
      return;
    }
    setTimeout(async () => {
      await this.#spawnSlot(slot);
      this.emit('health', { healthy: this.healthy, live: this.liveCount });
      this.#pump();
    }, BACKOFF_MS[attempt]);
  }

  /**
   * Выполнить задачу на свободном движке.
   * priority 'urgent' обгоняет 'normal': переоценка базовой позиции и подтверждающий
   * проход не должны стоять за полусотней отборочных.
   */
  run(taskFn, { priority = 'normal', signal = null } = {}) {
    if (this.#disposed) return Promise.reject(new EngineError(ERR.SHUTDOWN, 'пул остановлен'));
    return new Promise((resolve, reject) => {
      const job = { taskFn, priority, resolve, reject, signal, cancelled: false };
      if (signal) {
        if (signal.aborted) {
          reject(new EngineError(ERR.ABORTED, 'задача отменена до постановки в очередь'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            if (job.started) return; // запущенную остановит сам движок через свой signal
            job.cancelled = true;
            const i = this.#queue.indexOf(job);
            if (i >= 0) this.#queue.splice(i, 1);
            reject(new EngineError(ERR.ABORTED, 'задача снята из очереди'));
          },
          { once: true },
        );
      }
      if (priority === 'urgent') {
        // Вставляем после других urgent, но перед всеми normal.
        const at = this.#queue.findIndex((j) => j.priority !== 'urgent');
        if (at === -1) this.#queue.push(job);
        else this.#queue.splice(at, 0, job);
      } else {
        this.#queue.push(job);
      }
      this.#pump();
    });
  }

  #pump() {
    if (this.#disposed) return;
    while (this.#queue.length > 0) {
      const slot = this.#slots.find((s) => s.available);
      if (!slot) return;
      const job = this.#queue.shift();
      if (!job || job.cancelled) continue;
      this.#execute(slot, job);
    }
  }

  async #execute(slot, job) {
    // Помечаем слот занятым СИНХРОННО, до первого await: #pump крутится в цикле
    // и без этого раздал бы тот же слот всей очереди разом.
    slot.busy = true;
    job.started = true;
    this.#running += 1;
    if (this.#running > this.#peakConcurrency) this.#peakConcurrency = this.#running;
    const engine = slot.engine;
    try {
      const value = await job.taskFn(engine);
      job.resolve(value);
    } catch (err) {
      job.reject(err);
    } finally {
      this.#running -= 1;
      slot.busy = false;
      // Движок мог умереть внутри задачи: тогда слот уже перезапускается сам.
      this.#pump();
    }
  }

  // ─────────────────────────────────────────────── удобные обёртки

  analyse(params, { priority = 'normal', signal = null } = {}) {
    return this.run((engine) => engine.analyse({ ...params, signal }), { priority, signal });
  }

  staticEval(fen, { priority = 'normal', signal = null } = {}) {
    return this.run((engine) => engine.staticEval(fen), { priority, signal });
  }

  /** Все задачи разом, с сохранением порядка результатов. */
  map(items, taskFn, { priority = 'normal', signal = null } = {}) {
    return Promise.all(items.map((item, i) => this.run((engine) => taskFn(engine, item, i), { priority, signal })));
  }

  /**
   * Совокупная скорость пула в узлах/с. От неё генератор десанта считает свои бюджеты:
   * та же машина на батарее или под чужой нагрузкой выдаёт вдвое меньше, и лучше
   * подстроить объём поиска, чем упереться в таймаут.
   */
  async calibrate({ nodes = 300000, fen = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4' } = {}) {
    const live = this.#slots.filter((s) => s.engine && s.engine.alive).length;
    if (live === 0) return { aggregateNps: 0, workers: 0 };
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: live }, () => this.run((engine) => engine.analyse({ fen, nodes, newGame: true }))),
    );
    const ms = Math.max(1, Date.now() - t0);
    const aggregateNps = Math.round((live * nodes * 1000) / ms);
    this.emit('calibrated', { aggregateNps, workers: live, ms });
    return { aggregateNps, workers: live, ms };
  }

  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    const pending = this.#queue.splice(0);
    for (const job of pending) job.reject(new EngineError(ERR.SHUTDOWN, 'пул остановлен'));
    await Promise.all(this.#slots.map((s) => (s.engine ? s.engine.dispose() : Promise.resolve())));
    this.#slots = [];
  }
}

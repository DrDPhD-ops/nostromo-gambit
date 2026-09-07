// Обёртка ОДНОГО процесса движка, говорящего по UCI.
//
// Три вещи, ради которых этот файл написан именно так:
//   1. Никогда `shell: true`. На Windows это ставит cmd.exe между нами и движком:
//      kill() убивает оболочку и оставляет stockfish.exe сиротой, а строка команды
//      переразбирается в кодировке консоли, что ломает не-ASCII пути.
//   2. Построчный буфер с сохранением хвоста. stdout приходит кусками, которые режут
//      строки посреди токенов; наивный split теряет данные.
//   3. Ровно одна задача одновременно. UCI — не мультиплексируемый протокол: второй
//      `go` до `bestmove` рассинхронизирует всё дальнейшее.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { recordPid, forgetPid, killTreeSync } from './registry.mjs';
import { parseInfoLine, parseEvalOutput, createCurve, feedCurve, scoreAt, depthSpread } from './evaluate.mjs';

export const ERR = {
  HANDSHAKE: 'ENGINE_HANDSHAKE',
  TIMEOUT: 'ENGINE_TIMEOUT',
  CRASHED: 'ENGINE_CRASHED',
  SHUTDOWN: 'ENGINE_SHUTDOWN',
  BUSY: 'ENGINE_BUSY',
  ABORTED: 'ENGINE_ABORTED',
};

export class EngineError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'EngineError';
    this.code = code;
  }
}

const DEFAULT_OPTIONS = {
  Threads: 1,
  Hash: 64,
  MultiPV: 1,
  Ponder: false,
  UCI_ShowWDL: true,
};

export class UciEngine extends EventEmitter {
  #child = null;
  #buf = '';
  #task = null;
  #disposed = false;
  #multipv = 1;

  constructor({ exePath, args = [], cwd, options = {}, label = 'engine' }) {
    super();
    if (!exePath) throw new Error('UciEngine: не задан путь к движку');
    this.exePath = exePath;
    this.args = args;
    // cwd берём рядом с бинарём: он лежит в ASCII-пути под %LOCALAPPDATA%,
    // тогда как каталог проекта может быть кириллическим и с пробелами.
    this.cwd = cwd || path.dirname(exePath);
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.label = label;
    this.id = null;
    this.uciOptions = new Map();
  }

  get alive() {
    return Boolean(this.#child) && this.#child.exitCode === null && !this.#child.killed;
  }

  get busy() {
    return this.#task !== null;
  }

  get pid() {
    return this.#child ? this.#child.pid : null;
  }

  // ─────────────────────────────────────────────── запуск и хендшейк

  async start({ handshakeTimeoutMs = 20000 } = {}) {
    if (this.#child) throw new Error('UciEngine: уже запущен');

    this.#child = spawn(this.exePath, this.args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.cwd,
      // shell НЕ указываем осознанно — см. комментарий в шапке файла.
    });

    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk) => this.#onData(chunk));
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (d) => this.emit('stderr', String(d)));

    // Запись в stdin умершего процесса даёт EPIPE АСИНХРОННО, событием на потоке,
    // мимо любого try/catch вокруг write(). Без этого обработчика штатный останов
    // уже убитого движка роняет весь процесс.
    this.#child.stdin.on('error', (err) => this.emit('stdinError', err));

    this.#child.on('error', (err) => this.#onDeath(new EngineError(ERR.CRASHED, err.message)));
    this.#child.on('exit', (code, signal) => {
      if (this.#disposed) return;
      this.#onDeath(new EngineError(ERR.CRASHED, `движок завершился (код ${code}, сигнал ${signal})`));
    });

    recordPid(this.#child.pid, this.exePath);

    const idLines = [];
    await this.#exchange({
      name: 'uci',
      send: 'uci',
      timeoutMs: handshakeTimeoutMs,
      timeoutCode: ERR.HANDSHAKE,
      onLine: (line, done) => {
        if (line.startsWith('id name ')) this.id = line.slice(8).trim();
        if (line.startsWith('option name ')) {
          const m = /^option name (.+?) type /.exec(line);
          if (m) this.uciOptions.set(m[1], line);
        }
        idLines.push(line);
        if (line === 'uciok') done(true);
      },
    });

    for (const [name, value] of Object.entries(this.options)) {
      if (value === null || value === undefined) continue;
      this.#write(`setoption name ${name} value ${typeof value === 'boolean' ? String(value) : value}`);
    }
    this.#multipv = Number(this.options.MultiPV) || 1;

    await this.isReady({ timeoutMs: handshakeTimeoutMs });
    this.emit('ready', { id: this.id, pid: this.pid });
    return this;
  }

  /**
   * Прогрев: первый поиск разворачивает NNUE и греет предсказатели, поэтому
   * измерять по нему скорость нельзя, а платить эту цену в первом же десанте — обидно.
   */
  async warmup({ nodes = 150000 } = {}) {
    await this.analyse({ fen: 'startpos', nodes, newGame: true, timeoutMs: 60000 });
  }

  // ─────────────────────────────────────────────── задачи

  async isReady({ timeoutMs = 10000 } = {}) {
    return this.#exchange({
      name: 'isready',
      send: 'isready',
      timeoutMs,
      onLine: (line, done) => {
        if (line === 'readyok') done(true);
      },
    });
  }

  async setMultiPv(n) {
    const want = Math.max(1, Math.round(n));
    if (want === this.#multipv) return;
    this.#write(`setoption name MultiPV value ${want}`);
    this.#multipv = want;
    await this.isReady();
  }

  /**
   * Поиск с фиксированным бюджетом УЗЛОВ, а не глубины.
   *
   * `go depth N` невоспроизводим: под чужой нагрузкой движок успевает разное
   * количество работы и на той же «глубине» выдаёт другую оценку. Бюджет узлов
   * даёт одинаковый результат на загруженной и свободной машине — это то, на чём
   * держатся и детерминизм тестов, и честность сравнения «до/после» десанта.
   */
  async analyse({
    fen,
    nodes = 200000,
    multipv = 1,
    newGame = true,
    timeoutMs = 20000,
    signal = null,
  } = {}) {
    if (multipv !== this.#multipv) await this.setMultiPv(multipv);

    if (newGame) {
      // Чистим таблицу перестановок: без этого оценка позиции зависит от того,
      // что движок считал до неё, и одинаковые входы дают разные выходы.
      this.#write('ucinewgame');
      await this.isReady({ timeoutMs });
    }

    const sideToMove = fen === 'startpos' ? 'w' : (fen.split(/\s+/)[1] === 'b' ? 'b' : 'w');
    const curve = createCurve();
    const perPv = new Map();
    let best = null;
    let raw = 0;

    const result = await this.#exchange({
      name: 'go',
      send: [
        fen === 'startpos' ? 'position startpos' : `position fen ${fen}`,
        `go nodes ${Math.max(1, Math.round(nodes))}`,
      ],
      timeoutMs,
      signal,
      onLine: (line, done) => {
        if (line.startsWith('info ')) {
          const parsed = parseInfoLine(line);
          if (!parsed) return;
          raw += 1;
          const pv = parsed.multipv || 1;
          if (pv === 1) feedCurve(curve, parsed, sideToMove);
          perPv.set(pv, { depth: parsed.depth, score: parsed.score, pv: parsed.pv });
          return;
        }
        if (line.startsWith('bestmove')) {
          best = line.split(/\s+/)[1] || null;
          done(true);
        }
      },
      onTimeout: async (retry) => {
        // Вежливо просим остановиться и ждём bestmove: недополученный bestmove
        // рассинхронизирует протокол для всех следующих задач.
        this.#write('stop');
        return retry(500);
      },
      onAbort: () => this.#write('stop'),
    });

    if (result === ERR.ABORTED) throw new EngineError(ERR.ABORTED, 'поиск отменён');

    const depth = curve.maxDepth;
    return {
      fen,
      nodes,
      sideToMove,
      curve,
      depth,
      score: scoreAt(curve, depth),
      spread: depthSpread(curve, depth),
      pv: curve.pv,
      best,
      multipv: perPv,
      infoLines: raw,
    };
  }

  /** Статическая оценка NNUE. Дёшево (~2 мс) и хватает для предварительного отбора. */
  async staticEval(fen, { timeoutMs = 8000 } = {}) {
    let text = '';
    await this.#exchange({
      name: 'eval',
      send: [fen === 'startpos' ? 'position startpos' : `position fen ${fen}`, 'eval', 'isready'],
      timeoutMs,
      onLine: (line, done) => {
        if (line === 'readyok') done(true);
        else text += `${line}\n`;
      },
    });
    return parseEvalOutput(text);
  }

  /**
   * FEN так, как его понял сам движок. Нужен ровно для одного теста, но этот тест
   * ловит все расхождения по взятию на проходе, рокировкам и счётчику 50 ходов
   * между нашей нормализацией и движком.
   */
  async debugFen(fen, { timeoutMs = 8000 } = {}) {
    let out = null;
    await this.#exchange({
      name: 'd',
      send: [fen === 'startpos' ? 'position startpos' : `position fen ${fen}`, 'd', 'isready'],
      timeoutMs,
      onLine: (line, done) => {
        if (line.startsWith('Fen: ')) out = line.slice(5).trim();
        if (line === 'readyok') done(true);
      },
    });
    return out;
  }

  // ─────────────────────────────────────────────── низкий уровень

  #write(cmd) {
    // Порядок проверок важен: остановленный движок обязан сообщать SHUTDOWN,
    // а не CRASHED, иначе вызывающий не отличит «мы сами его выключили»
    // от «он упал» и полезет его перезапускать.
    if (this.#disposed) throw new EngineError(ERR.SHUTDOWN, 'движок остановлен');
    if (!this.#child || !this.#child.stdin.writable) {
      throw new EngineError(ERR.CRASHED, 'движок не принимает команды');
    }
    this.#child.stdin.write(`${cmd}\n`);
    this.emit('command', cmd);
  }

  #onData(chunk) {
    this.#buf += chunk;
    const lines = this.#buf.split('\n');
    // Хвост может быть неполной строкой — оставляем его до следующего куска.
    this.#buf = lines.pop();
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '').trim();
      if (!line) continue;
      this.emit('line', line);
      const task = this.#task;
      if (!task) continue;
      try {
        task.onLine(line, task.done);
      } catch (err) {
        task.fail(err);
      }
    }
  }

  #onDeath(err) {
    const task = this.#task;
    this.#task = null;
    if (this.#child) forgetPid(this.#child.pid);
    if (task) {
      clearTimeout(task.timer);
      task.reject(err);
    }
    this.emit('died', err);
  }

  /**
   * Единственная точка, где выполняется задача. Слот один: попытка запустить
   * вторую задачу — это ошибка вызывающего (пул обязан обеспечивать эксклюзивность),
   * и мы её не прощаем, а сообщаем.
   */
  #exchange({ name, send, onLine, timeoutMs = 15000, timeoutCode = ERR.TIMEOUT, signal = null, onTimeout = null, onAbort = null }) {
    if (this.#task) {
      return Promise.reject(
        new EngineError(ERR.BUSY, `движок занят задачей «${this.#task.name}», получена «${name}»`),
      );
    }
    if (this.#disposed) return Promise.reject(new EngineError(ERR.SHUTDOWN, 'движок остановлен'));
    if (!this.alive) return Promise.reject(new EngineError(ERR.CRASHED, 'процесс движка не запущен'));

    return new Promise((resolve, reject) => {
      let settled = false;
      let aborted = false;

      const cleanup = () => {
        clearTimeout(task.timer);
        if (signal && onAbortEvent) signal.removeEventListener('abort', onAbortEvent);
        this.#task = null;
      };
      const done = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(aborted ? ERR.ABORTED : value);
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const armTimer = (ms) =>
        setTimeout(async () => {
          if (settled) return;
          if (onTimeout) {
            // Даём задаче шанс завершиться корректно (обычно: `stop` -> `bestmove`).
            const retried = await onTimeout((graceMs) => {
              task.timer = setTimeout(() => {
                if (settled) return;
                this.#killNow();
                fail(new EngineError(timeoutCode, `таймаут задачи «${name}» (${ms} мс + ${graceMs} мс)`));
              }, graceMs);
              return true;
            });
            if (retried) return;
          }
          this.#killNow();
          fail(new EngineError(timeoutCode, `таймаут задачи «${name}» (${ms} мс)`));
        }, ms);

      const task = { name, onLine, done, fail, reject: fail, timer: null };
      task.timer = armTimer(timeoutMs);
      this.#task = task;

      let onAbortEvent = null;
      if (signal) {
        if (signal.aborted) {
          cleanup();
          reject(new EngineError(ERR.ABORTED, 'задача отменена до запуска'));
          return;
        }
        onAbortEvent = () => {
          aborted = true;
          if (onAbort) onAbort();
          else done(ERR.ABORTED);
        };
        signal.addEventListener('abort', onAbortEvent, { once: true });
      }

      try {
        for (const cmd of Array.isArray(send) ? send : [send]) this.#write(cmd);
      } catch (err) {
        fail(err);
      }
    });
  }

  #killNow() {
    if (!this.#child) return;
    const pid = this.#child.pid;
    try {
      this.#child.kill();
    } catch {
      /* уже мёртв */
    }
    killTreeSync(pid);
    forgetPid(pid);
  }

  /** Останов по слоям: quit -> kill -> taskkill /T /F. На Windows гарантирует только последний. */
  async dispose({ graceMs = 1000 } = {}) {
    if (this.#disposed) return;
    this.#disposed = true;

    const task = this.#task;
    this.#task = null;
    if (task) {
      clearTimeout(task.timer);
      task.reject(new EngineError(ERR.SHUTDOWN, 'движок останавливается'));
    }

    const child = this.#child;
    if (!child) return;
    const pid = child.pid;

    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      if (child.stdin.writable) child.stdin.write('quit\n');
    } catch {
      /* некому писать */
    }

    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise((r) => setTimeout(() => r(true), graceMs)),
    ]);

    if (timedOut) {
      try {
        child.kill();
      } catch {
        /* уже мёртв */
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 300))]);
      killTreeSync(pid);
    }
    forgetPid(pid);
    this.#child = null;
  }
}

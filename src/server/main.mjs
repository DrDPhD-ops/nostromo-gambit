#!/usr/bin/env node
// Точка входа. Здесь сходятся партия, пул движков, аналитический движок и поток событий.
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Game, DEFAULT_SETTINGS } from '../game/game.mjs';
import { generateBalancedDrop } from '../game/dropGenerator.mjs';
import { makeRng } from '../game/rng.mjs';
import { rollDice, interpretRoll, describeRoll } from '../game/dice.mjs';
import { storytellerList, getStoryteller } from '../game/storytellers.mjs';
import { fischerFen } from '../game/fischer.mjs';
import { chooseComputerMove, levelList, getLevel } from '../game/computer.mjs';
import { EnginePool, recommendedPoolSize } from '../engine/pool.mjs';
import { AnalysisEngine } from '../engine/analysis.mjs';
import { reapOrphans, killOwnEnginesSync } from '../engine/registry.mjs';
import { readJsonSafe, CURRENT_JSON } from '../shared/paths.mjs';
import { SseHub } from './sse.mjs';
import { createRouter } from './http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, '..', '..', 'public');
const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || '127.0.0.1';

class App {
  constructor({ engineInfo, useMockEngine = false }) {
    this.sessionId = randomUUID();
    this.engineInfo = engineInfo;
    this.useMockEngine = useMockEngine;
    this.game = new Game();
    this.hub = new SseHub({ sessionId: this.sessionId });
    this.pool = null;
    this.analysis = null;
    this.aggregateNps = 0;
    this.dropInProgress = null;
    this.dropAbort = null;
    this.computerThinking = false;
    this.rng = makeRng(this.game.seed);
  }

  // ─────────────────────────────────────────── запуск и останов

  async start() {
    // Отстреливаем движки, оставшиеся от прошлых запусков: закрытое окно терминала
    // и Task Manager не дают шанса на штатный останов.
    const reaped = reapOrphans({ verbose: true });
    if (reaped.length) console.log(`  убрано осиротевших движков: ${reaped.length}`);

    if (this.useMockEngine) {
      const { MockEngine } = await import('../engine/mock.mjs');
      this.pool = new EnginePool({ createEngine: () => new MockEngine(), size: 2, warmupNodes: 0 });
      await this.pool.start();
      this.aggregateNps = 2_000_000;
      return this;
    }

    this.pool = new EnginePool({
      exePath: this.engineInfo.path,
      args: this.engineInfo.args || [],
      size: recommendedPoolSize(),
      options: { Threads: 1, Hash: 16 },
    });
    await this.pool.start();
    const cal = await this.pool.calibrate({ nodes: 200000 });
    this.aggregateNps = cal.aggregateNps;
    console.log(`  пул: ${cal.workers} воркеров, совокупно ${(cal.aggregateNps / 1e6).toFixed(2)} Mnps`);

    this.analysis = new AnalysisEngine({
      exePath: this.engineInfo.path,
      args: this.engineInfo.args || [],
      nodes: Math.max(300000, Math.round(this.aggregateNps * 0.6)),
    });
    await this.analysis.start();
    this.analysis.on('eval', (e) => {
      if (this.game.settings.showEval) this.hub.emitVolatile('eval', e);
    });
    this.analysis.setPosition(this.game.fen);
    return this;
  }

  async dispose() {
    this.dropAbort?.abort();
    this.hub.close();
    await Promise.allSettled([this.analysis?.dispose(), this.pool?.dispose()]);
  }

  // ─────────────────────────────────────────── состояние

  snapshot(extra = {}) {
    return this.game.snapshot({
      sessionId: this.sessionId,
      engine: {
        kind: this.useMockEngine ? 'mock' : this.engineInfo?.kind || 'native',
        name: this.useMockEngine ? 'MockFish' : this.engineInfo?.uciName || '—',
        healthy: this.pool ? this.pool.healthy : false,
        workers: this.pool ? this.pool.liveCount : 0,
        nps: this.aggregateNps,
      },
      storytellers: storytellerList(),
      levels: levelList(),
      dropInProgress: this.dropInProgress,
      ...extra,
    });
  }

  health() {
    return {
      sessionId: this.sessionId,
      version: this.game.version,
      engine: this.pool ? this.pool.healthy : false,
      uptimeMs: Math.round(process.uptime() * 1000),
    };
  }

  attachEventStream(req, res) {
    const lastId = req.headers['last-event-id'];
    this.hub.attach(req, res, {
      lastEventId: lastId,
      initial: { event: 'snapshot', data: this.snapshot(), id: this.game.version },
    });
  }

  #broadcastState(event = 'state') {
    this.hub.emit(event, this.snapshot(), { id: this.game.version });
  }

  #retarget() {
    if (this.analysis) this.analysis.setPosition(this.game.fen);
  }

  // ─────────────────────────────────────────── действия

  async handleMove(body) {
    const result = this.game.move({ from: body.from, to: body.to, promotion: body.promotion });
    if (!result.ok) return result;
    this.#broadcastState('move');
    this.#retarget();

    // Автоматический десант приходит ПОСЛЕ хода чёрных, то есть на границе полного
    // хода: иначе одна из сторон систематически получала бы подкрепление первой.
    if (this.game.autoDropDue && !this.game.gameOver && !this.dropInProgress) {
      this.#runDrop({ trigger: 'auto' }).catch((err) => console.error('[десант]', err));
    } else {
      this.#maybeComputerMove();
    }
    return { ok: true, version: this.game.version };
  }

  /** Сидит ли за этой стороной компьютер. */
  #isComputer(side) {
    const players = this.game.settings.players || {};
    return players[side] === 'computer';
  }

  /**
   * Ход компьютера, если сейчас его очередь.
   *
   * Намеренно не await: ход считается в фоне, а состояние уезжает клиенту событием.
   * Иначе HTTP-ответ на ход человека ждал бы, пока движок додумает свой, и интерфейс
   * замирал бы на секунды без единого признака жизни.
   */
  #maybeComputerMove() {
    if (this.computerThinking || this.dropInProgress) return;
    if (this.game.gameOver || !this.#isComputer(this.game.turn)) return;
    if (!this.pool || !this.pool.healthy) return;

    this.computerThinking = true;
    const side = this.game.turn;
    const versionAtStart = this.game.version;
    this.hub.emitVolatile('thinking', { side, level: getLevel(this.game.settings.computerLevel).name });

    (async () => {
      try {
        const choice = await chooseComputerMove(this.pool, this.game.fen, {
          level: this.game.settings.computerLevel,
          rng: this.rng,
        });
        // Пока движок думал, партию могли отменить, начать заново или высадить десант.
        if (!choice || this.game.version !== versionAtStart) return;
        const r = this.game.move(choice);
        if (!r.ok) return;
        this.#broadcastState('move');
        this.#retarget();
        if (this.game.autoDropDue && !this.game.gameOver && !this.dropInProgress) {
          this.#runDrop({ trigger: 'auto' }).catch((err) => console.error('[десант]', err));
        }
      } catch (err) {
        console.error('[компьютер]', err.message);
      } finally {
        this.computerThinking = false;
        // Компьютер против компьютера: следующий ход запускается той же цепочкой.
        setTimeout(() => this.#maybeComputerMove(), 120);
      }
    })();
  }

  async handleRoll(body) {
    const side = body.side === 'b' ? 'b' : 'w';
    if (this.dropInProgress) {
      return { ok: false, code: 'DROP_IN_PROGRESS', message: 'ВЫСАДКА УЖЕ ИДЁТ' };
    }
    if (this.game.gameOver) return { ok: false, code: 'GAME_OVER', message: 'ПАРТИЯ ОКОНЧЕНА' };
    if (this.game.turn !== side) return { ok: false, code: 'NOT_YOUR_TURN', message: 'СЕЙЧАС НЕ ВАШ ХОД' };
    if (this.game.dice[side] <= 0) return { ok: false, code: 'NO_TOKENS', message: 'БРОСКИ ЗАКОНЧИЛИСЬ' };

    this.game.spendDiceRoll(side);
    const roll = interpretRoll(rollDice(this.rng), side);
    this.game.version += 1;
    this.hub.emit('dice', { roll, text: describeRoll(roll), dice: this.game.dice }, { id: this.game.version });

    this.#runDrop({ trigger: 'dice', roll }).catch((err) => console.error('[десант]', err));
    return { ok: true, version: this.game.version, roll };
  }

  async handleNewGame(body) {
    if (this.dropInProgress) return { ok: false, code: 'DROP_IN_PROGRESS', message: 'ВЫСАДКА УЖЕ ИДЁТ' };
    const settings = { ...this.game.settings, ...(body.settings || {}) };
    const seed = body.seed || `game-${Date.now()}`;
    // Расстановка Фишера берётся из того же сида, что и вся партия: одинаковый сид
    // даёт одинаковую стартовую позицию, и партию можно воспроизвести целиком.
    const startFen = settings.startPosition === 'fischer' ? fischerFen(makeRng(`fischer:${seed}`)) : undefined;
    this.game = new Game({ settings, seed, ...(startFen ? { fen: startFen } : {}) });
    this.rng = makeRng(seed);
    this.#broadcastState('snapshot');
    this.#retarget();
    this.#maybeComputerMove();
    return { ok: true, version: this.game.version };
  }

  async handleUndo() {
    if (this.dropInProgress) return { ok: false, code: 'DROP_IN_PROGRESS', message: 'ВЫСАДКА УЖЕ ИДЁТ' };
    const r = this.game.undo();
    if (!r.ok) return r;
    this.#broadcastState('snapshot');
    this.#retarget();
    return { ok: true, version: this.game.version };
  }

  async handleSettings(body) {
    const allowed = Object.keys(DEFAULT_SETTINGS);
    const next = { ...this.game.settings };
    for (const [k, v] of Object.entries(body || {})) {
      if (!allowed.includes(k)) continue;
      next[k] = v;
    }
    if (next.autoDropEveryFullMoves !== null) {
      next.autoDropEveryFullMoves = Math.max(0, Math.min(20, Number(next.autoDropEveryFullMoves) || 0));
    }
    next.diceRollsPerPlayer = Math.max(0, Math.min(9, Number(next.diceRollsPerPlayer) || 0));
    next.computerLevel = Math.max(1, Math.min(5, Number(next.computerLevel) || 3));
    const seats = next.players && typeof next.players === 'object' ? next.players : {};
    next.players = {
      w: seats.w === 'computer' ? 'computer' : 'human',
      b: seats.b === 'computer' ? 'computer' : 'human',
    };
    if (next.startPosition !== 'fischer') next.startPosition = 'standard';
    if (!getStoryteller(next.storyteller)) next.storyteller = 'bishop';
    this.game.settings = next;
    this.game.version += 1;
    this.#broadcastState('settings');
    this.#maybeComputerMove();
    return { ok: true, version: this.game.version, settings: next };
  }

  /** Только для end-to-end проверок: поставить произвольную позицию. */
  async handleTestFen(body) {
    try {
      this.game = new Game({ fen: body.fen, settings: this.game.settings });
      this.rng = makeRng(this.game.seed);
      this.#broadcastState('snapshot');
      this.#retarget();
      return { ok: true, version: this.game.version };
    } catch (err) {
      return { ok: false, code: 'BAD_REQUEST', message: `НЕВЕРНАЯ ПОЗИЦИЯ: ${err.message}` };
    }
  }

  // ─────────────────────────────────────────── десант

  async #runDrop({ trigger, roll = null }) {
    if (this.dropInProgress) return;
    if (!this.pool || !this.pool.healthy) {
      this.hub.emit('drop:skipped', { reason: 'ДВИЖОК НЕДОСТУПЕН' }, { id: this.game.version });
      return;
    }

    const id = this.game.dropLog.length + 1;
    this.dropInProgress = { id, phase: 'baseline', done: 0, total: 1, trigger };
    this.game.phase = 'dropping';
    this.dropAbort = new AbortController();
    this.#broadcastState('drop:start');

    // Поиск десанта — приоритет по ядрам; шкала оценки на это время замолкает.
    await this.analysis?.pause();

    try {
      const result = await generateBalancedDrop(this.pool, this.game.fen, {
        rng: this.rng,
        storytellerId: this.game.settings.storyteller,
        dice: roll,
        ledgerCp: this.game.ledgerCp,
        aggregateNps: this.aggregateNps,
        signal: this.dropAbort.signal,
        toleranceOverride: this.game.settings.toleranceOverride,
        dropOptions: {
          allowNearPromotion: this.game.settings.allowNearPromotion,
          forbidCheck: this.game.settings.forbidCheckOnDrop,
        },
        onProgress: (p) => {
          this.dropInProgress = { id, ...p, trigger };
          this.hub.emitVolatile('drop:progress', { id, ...p });
        },
      });

      this.game.phase = 'idle';
      this.dropInProgress = null;

      if (result.ok) {
        this.game.applyDrop(result);
        this.hub.emit(
          'drop:done',
          { drop: this.game.dropLog[this.game.dropLog.length - 1], state: this.snapshot() },
          { id: this.game.version },
        );
      } else {
        // Честный отказ лучше подделанного десанта: жетон возвращается,
        // а причина показывается игроку словами.
        if (trigger === 'dice' && roll) this.game.refundDiceRoll(roll.side);
        this.game.noteSkippedDrop(result.reason);
        this.hub.emit(
          'drop:skipped',
          { id, reason: result.reason, state: this.snapshot() },
          { id: this.game.version },
        );
      }
    } catch (err) {
      this.game.phase = 'idle';
      this.dropInProgress = null;
      if (trigger === 'dice' && roll) this.game.refundDiceRoll(roll.side);
      this.game.noteSkippedDrop(`сбой поиска: ${err.message}`);
      this.hub.emit('drop:skipped', { id, reason: `СБОЙ ПОИСКА: ${err.message}`, state: this.snapshot() }, { id: this.game.version });
    } finally {
      this.dropAbort = null;
      this.analysis?.resume(this.game.fen);
      this.#maybeComputerMove();
    }
  }
}

// ─────────────────────────────────────────── запуск

async function main() {
  const useMock = process.env.ENGINE === 'mock';
  const engineInfo = useMock ? null : readJsonSafe(CURRENT_JSON);
  if (!useMock && !engineInfo) {
    console.error('Движок не установлен. Выполните:  npm run setup');
    process.exit(1);
  }

  console.log('NOSTROMO GAMBIT');
  if (engineInfo) console.log(`  движок: ${engineInfo.uciName} (${engineInfo.kind})`);

  const app = new App({ engineInfo, useMockEngine: useMock });
  await app.start();

  const server = http.createServer(createRouter({ app, publicDir: PUBLIC_DIR }));
  await new Promise((resolve) => server.listen(PORT, HOST, resolve));
  console.log(`  открыто: http://${HOST}:${PORT}`);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      // Второе нажатие — уже без вежливости.
      killOwnEnginesSync();
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`\n  ${signal}: останов…`);
    server.close();
    await app.dispose();
    process.exit(0);
  };

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(sig, () => shutdown(sig));
  }
  // Последний рубеж: синхронный обработчик, где промисы уже не работают.
  process.on('exit', () => killOwnEnginesSync());
  process.on('uncaughtException', (err) => {
    console.error('[фатально]', err);
    shutdown('uncaughtException');
  });
}

// Модуль импортируется тестами, поэтому сервер поднимается только при прямом запуске.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { App, main };

#!/usr/bin/env node
// Поддельный движок: настоящий дочерний процесс, говорящий на минимальном UCI.
//
// Нужен, чтобы проверять проволочный протокол и жизненный цикл процесса, не платя
// за запуск настоящего Stockfish. Умеет вести себя плохо — именно ради этого он и есть.
//
// Флаги:
//   --slow=<мс>        задержка перед каждым ответом
//   --crash-after=<N>  умереть после N команд `go`
//   --ignore-stop      не реагировать на `stop` (проверка таймаута и убийства)
//   --chunked          резать вывод посреди строк (проверка построчного буфера)
//   --no-uciok         не отвечать на `uci` (проверка таймаута хендшейка)
//   --slow-quit        игнорировать `quit` (проверка эскалации до kill)
import readline from 'node:readline';

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};

const SLOW = Number(flag('slow', 0)) || 0;
const CRASH_AFTER = flag('crash-after') ? Number(flag('crash-after')) : Infinity;
const IGNORE_STOP = Boolean(flag('ignore-stop'));
const CHUNKED = Boolean(flag('chunked'));
const NO_UCIOK = Boolean(flag('no-uciok'));
const SLOW_QUIT = Boolean(flag('slow-quit'));

let goCount = 0;
let searching = null; // таймер текущего «поиска»
let currentFen = 'startpos';
const commandLog = [];

// Очередь нужна именно для --chunked: две строки, отправленные одновременно,
// иначе перемешали бы свои куски и породили мусор, которого настоящий движок
// не выдаёт. Мы проверяем разбор разрезанных строк, а не устойчивость к бреду.
const outQueue = [];
let draining = false;

function drain() {
  if (draining) return;
  const payload = outQueue.shift();
  if (payload === undefined) return;
  draining = true;
  const cut = Math.max(1, Math.floor(payload.length * 0.4));
  process.stdout.write(payload.slice(0, cut));
  setTimeout(() => {
    process.stdout.write(payload.slice(cut));
    draining = false;
    drain();
  }, 1);
}

/** Пишем либо целиком, либо кусками, разрезая посреди токенов. */
function say(text) {
  const payload = `${text}\n`;
  if (!CHUNKED) {
    process.stdout.write(payload);
    return;
  }
  outQueue.push(payload);
  drain();
}

const delay = (fn) => (SLOW ? setTimeout(fn, SLOW) : fn());

/** Детерминированная «оценка» из FEN: одинаковый вход — одинаковый выход. */
function hashScore(fen) {
  let h = 2166136261;
  for (let i = 0; i < fen.length; i++) {
    h ^= fen.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 401) - 200; // −200..200 сп
}

function sideToMove(fen) {
  const parts = fen.split(/\s+/);
  return parts[1] === 'b' ? 'b' : 'w';
}

function runSearch(nodesBudget) {
  goCount += 1;
  if (goCount > CRASH_AFTER) {
    process.exit(3); // «падение» движка
  }

  const base = hashScore(currentFen);
  const maxDepth = Math.max(2, Math.min(24, Math.round(Math.log2(Math.max(nodesBudget, 1000)) * 1.4)));
  let depth = 1;

  const step = () => {
    if (depth > maxDepth) {
      searching = null;
      // Ход берём стабильный: тесты сверяют только сам факт и порядок.
      say('bestmove e2e4 ponder e7e5');
      return;
    }
    // Немного «дрожания» по глубине — как у настоящего движка.
    const jitter = ((base + depth * 7) % 11) - 5;
    const cp = base + (depth >= maxDepth - 1 ? 0 : jitter);
    const nodes = Math.round((nodesBudget * depth) / maxDepth);
    if (depth === 3) {
      // Строка с границей окна поиска: разбор обязан её проигнорировать.
      say(`info depth ${depth} seldepth ${depth + 4} multipv 1 score cp ${cp + 300} upperbound nodes ${nodes} pv e2e4`);
    }
    say(
      `info depth ${depth} seldepth ${depth + 5} multipv 1 score cp ${cp} wdl 200 600 200 ` +
        `nodes ${nodes} nps 1000000 time ${depth * 10} pv e2e4 e7e5`,
    );
    depth += 1;
    searching = setTimeout(step, SLOW || 1);
  };
  searching = setTimeout(step, SLOW || 1);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (raw) => {
  const line = raw.trim();
  if (!line) return;
  commandLog.push(line);

  if (line === 'uci') {
    if (NO_UCIOK) return;
    delay(() => {
      say('id name FakeFish 1.0');
      say('id author nostromo-gambit tests');
      say('option name Threads type spin default 1 min 1 max 1024');
      say('option name Hash type spin default 16 min 1 max 33554432');
      say('option name MultiPV type spin default 1 min 1 max 500');
      say('uciok');
    });
  } else if (line === 'isready') {
    delay(() => say('readyok'));
  } else if (line.startsWith('setoption') || line === 'ucinewgame') {
    // молча принимаем
  } else if (line.startsWith('position')) {
    const m = /position\s+fen\s+(.+?)(?:\s+moves\s|$)/.exec(line);
    currentFen = m ? m[1].trim() : 'startpos';
  } else if (line.startsWith('go')) {
    const m = /\bnodes\s+(\d+)/.exec(line);
    runSearch(m ? Number(m[1]) : 100000);
  } else if (line === 'stop') {
    if (IGNORE_STOP) return;
    if (searching) {
      clearTimeout(searching);
      searching = null;
      delay(() => say('bestmove e2e4'));
    }
  } else if (line === 'eval') {
    // Формат вывода настоящего Stockfish: оценка всегда от лица белых.
    const cp = hashScore(currentFen) / 100;
    delay(() => {
      say('NNUE derived piece values:');
      say(`Final evaluation       ${cp >= 0 ? '+' : ''}${cp.toFixed(2)} (white side) [with scaled NNUE]`);
    });
  } else if (line === 'd') {
    delay(() => {
      say('+---+---+---+---+---+---+---+---+');
      say(`Fen: ${currentFen}`);
      say(`Checkers: ${sideToMove(currentFen) === 'w' ? '' : ''}`);
    });
  } else if (line === 'quit') {
    if (SLOW_QUIT) return;
    process.exit(0);
  }
});

process.on('SIGTERM', () => process.exit(0));

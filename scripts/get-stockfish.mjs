#!/usr/bin/env node
// Установка движка Stockfish. Нулевые зависимости: глобальный fetch + node:*.
//
// Порядок: релиз -> выбор ассета -> проверка целостности -> возобновляемая загрузка
//          -> распаковка системным tar -> поиск exe -> UCI-проба -> калибровка nps
//          -> запись current.json.  Идемпотентно; безопасно вызывать на каждом старте.
//
// Флаги: --force  --latest  --tag=sf_18  --allow-unverified  --quiet
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  ENGINE_DIR,
  DOWNLOAD_DIR,
  CURRENT_JSON,
  RELEASE_CACHE,
  ensureDirs,
  writeJsonAtomic,
  readJsonSafe,
} from '../src/shared/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCK_FILE = path.join(HERE, 'stockfish.lock.json');

const REPO = 'official-stockfish/Stockfish';
const DEFAULT_TAG = 'sf_19';
const UA = 'nostromo-gambit/0.1 (+local build script)';
const RELEASE_CACHE_MS = 24 * 60 * 60 * 1000;

// Порядок предпочтения сборок. Для sf_19 существует только `universal`
// (диспетчеризация по CPU в рантайме), но список оставлен: при пине на sf_16/sf_17
// там есть отдельные bmi2/avx2, и на них же опирается шаг вниз при SIGILL.
const ISA_PREFERENCE = ['bmi2', 'avx2', 'sse41-popcnt', 'universal', 'x86-64'];

const args = process.argv.slice(2);
const FLAG = {
  force: args.includes('--force'),
  latest: args.includes('--latest'),
  allowUnverified: args.includes('--allow-unverified'),
  quiet: args.includes('--quiet'),
  tag: (args.find((a) => a.startsWith('--tag=')) || '').slice(6) || DEFAULT_TAG,
};

const log = (...m) => {
  if (!FLAG.quiet) console.log(...m);
};
const warn = (...m) => console.warn(...m);

// ─────────────────────────────────────────────────────────── платформа

function platformKey() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86-64';
  if (process.platform === 'win32') return { os: 'windows', arch, exe: '.exe' };
  if (process.platform === 'darwin') return { os: 'macos', arch, exe: '' };
  return { os: 'ubuntu', arch, exe: '' };
}

// ─────────────────────────────────────────────────────────── GitHub API

async function githubJson(url) {
  const headers = { 'User-Agent': UA, Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    throw new Error(
      `GitHub API ${res.status} ${res.statusText}` +
        (remaining === '0' ? ' (исчерпан лимит 60 запросов/час; задайте GITHUB_TOKEN)' : ''),
    );
  }
  return res.json();
}

async function resolveRelease() {
  const url = FLAG.latest
    ? `https://api.github.com/repos/${REPO}/releases/latest`
    : `https://api.github.com/repos/${REPO}/releases/tags/${FLAG.tag}`;

  const cached = readJsonSafe(RELEASE_CACHE);
  if (cached && cached.url === url && Date.now() - cached.at < RELEASE_CACHE_MS) {
    log(`  релиз из кэша: ${cached.release.tag_name}`);
    return cached.release;
  }
  const release = await githubJson(url);
  writeJsonAtomic(RELEASE_CACHE, { url, at: Date.now(), release });
  return release;
}

/** Ранжируем ассеты по списку предпочтений; skipIsa позволяет шагнуть вниз после SIGILL. */
function pickAsset(release, skipIsa = new Set()) {
  const { os: osKey, arch } = platformKey();
  const prefix = `stockfish-${osKey}-${arch}`;
  const candidates = (release.assets || []).filter(
    (a) => a.name.startsWith(prefix) && /\.(zip|tar)$/i.test(a.name),
  );
  for (const isa of ISA_PREFERENCE) {
    if (skipIsa.has(isa)) continue;
    const hit = candidates.find((a) => a.name.includes(isa));
    if (hit) return { asset: hit, isa };
  }
  const bare = candidates.find((a) => !skipIsa.has('bare'));
  if (bare) return { asset: bare, isa: 'bare' };
  return null;
}

// ─────────────────────────────────────────────────────────── целостность

function digestFromAsset(asset) {
  const d = asset.digest || '';
  const m = /^sha256:([0-9a-f]{64})$/i.exec(d);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Правило проверки: берём хеш из API и из lock-файла. Если оба есть и расходятся —
 * отказ: значит опубликованный ассет подменили. Если нет ни одного — отказ,
 * пока явно не передан --allow-unverified.
 */
function resolveExpectedDigest(asset) {
  const api = digestFromAsset(asset);
  const lock = readJsonSafe(LOCK_FILE);
  const pinned = lock && lock.assets && lock.assets[asset.name];
  const locked = pinned && pinned.sha256 ? String(pinned.sha256).toLowerCase() : null;

  if (api && locked && api !== locked) {
    throw new Error(
      `Хеш ассета ${asset.name} расходится с закреплённым.\n` +
        `  GitHub API : ${api}\n  lock-файл  : ${locked}\n` +
        `Опубликованный файл изменили. Установка прервана.`,
    );
  }
  const expected = api || locked;
  if (!expected && !FLAG.allowUnverified) {
    throw new Error(
      `Нет ни одного источника sha256 для ${asset.name}. ` +
        `Повторите с --allow-unverified, если это осознанное решение.`,
    );
  }
  if (locked && pinned.size && asset.size && pinned.size !== asset.size) {
    throw new Error(
      `Размер ассета ${asset.name} расходится с закреплённым: ${asset.size} против ${pinned.size}.`,
    );
  }
  return { expected, fromApi: Boolean(api), fromLock: Boolean(locked) };
}

function updateLockFile(asset, sha256, tag) {
  const lock = readJsonSafe(LOCK_FILE) || { note: 'TOFU-пин: переживает недоступность GitHub API', assets: {} };
  lock.tag = tag;
  lock.assets = lock.assets || {};
  lock.assets[asset.name] = {
    sha256,
    size: asset.size,
    url: asset.browser_download_url,
    pinnedAt: new Date().toISOString(),
  };
  writeJsonAtomic(LOCK_FILE, lock);
}

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

// ─────────────────────────────────────────────────────────── загрузка

function human(n) {
  return `${(n / 1e6).toFixed(1)} МБ`;
}

async function downloadResumable(url, target, expectedSize) {
  const part = `${target}.part`;
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (expectedSize && have > expectedSize) {
    fs.rmSync(part);
    have = 0;
  }
  if (expectedSize && have === expectedSize) {
    fs.renameSync(part, target);
    return;
  }

  const headers = { 'User-Agent': UA };
  if (have > 0) headers.Range = `bytes=${have}-`;
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} при загрузке ${url}`);

  // Сервер проигнорировал Range и отдал файл целиком — начинаем заново.
  let append = have > 0;
  if (have > 0 && res.status !== 206) {
    append = false;
    have = 0;
  }

  const total = expectedSize || (Number(res.headers.get('content-length')) || 0) + have;
  const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
  let done = have;
  let lastPrint = 0;

  const src = Readable.fromWeb(res.body);
  src.on('data', (chunk) => {
    done += chunk.length;
    const now = Date.now();
    if (!FLAG.quiet && now - lastPrint > 400) {
      lastPrint = now;
      const pct = total ? ((done / total) * 100).toFixed(1) : '?';
      process.stdout.write(`\r  загрузка ${human(done)} / ${human(total)}  ${pct}%   `);
    }
  });
  await pipeline(src, out);
  if (!FLAG.quiet) process.stdout.write(`\r  загрузка ${human(done)} / ${human(total)}  100.0%   \n`);
  fs.renameSync(part, target);
}

async function fetchAssetWithRetry(asset, target, expectedDigest) {
  const delays = [1000, 2000, 4000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await downloadResumable(asset.browser_download_url, target, asset.size);
      const actual = await sha256File(target);
      if (expectedDigest && actual !== expectedDigest) {
        // Битый резюм или подмена — уничтожаем и пробуем с нуля.
        fs.rmSync(target, { force: true });
        throw new Error(`sha256 не совпал: получено ${actual}, ожидалось ${expectedDigest}`);
      }
      return actual;
    } catch (err) {
      if (attempt === delays.length) throw err;
      warn(`  попытка ${attempt + 1} не удалась: ${err.message}`);
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  throw new Error('недостижимо');
}

// ─────────────────────────────────────────────────────────── распаковка

function run(cmd, argv, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { windowsHide: true, stdio: 'pipe', ...opts });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ code: -1, out, err: String(e.message) }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

async function extract(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });

  // Основной путь: bsdtar из System32 читает zip и не занимается glob-раскрытием.
  //
  // ВАЖНО: bsdtar разбирает ЛЮБОЙ аргумент с двоеточием диска как `host:path`
  // (`-f C:\...` -> «Cannot connect to C:», `-C C:\...` -> «C\:\...: Cannot open»).
  // Проверено экспериментально. Поэтому архив переносим в каталог назначения и
  // работаем только базовыми именами, без -C и без абсолютных путей.
  const inPlace = path.join(destDir, path.basename(archive));
  fs.renameSync(archive, inPlace);
  const tar = await run('tar', ['-xf', path.basename(inPlace)], { cwd: destDir });
  if (tar.code === 0) {
    fs.rmSync(inPlace, { force: true });
    return;
  }

  warn(`  tar не справился (${tar.code}): ${tar.err.trim().slice(0, 200)}`);
  fs.renameSync(inPlace, archive); // вернём на место для фолбэка
  if (process.platform !== 'win32') throw new Error('распаковка не удалась');

  // Фолбэк: PowerShell. Пути передаём переменными окружения и берём -LiteralPath,
  // иначе пробелы и кириллица в пути ломают раскрытие -Path.
  const ps = await run(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Expand-Archive -LiteralPath $env:SFSRC -DestinationPath $env:SFDST -Force',
    ],
    { env: { ...process.env, SFSRC: archive, SFDST: destDir } },
  );
  if (ps.code !== 0) throw new Error(`распаковка не удалась: ${ps.err.trim().slice(0, 300)}`);
}

/** Раскладку архива не хардкодим — она уже менялась между релизами. */
function findEngineBinary(dir) {
  const { exe } = platformKey();
  const found = [];
  const walk = (d, depth = 0) => {
    if (depth > 5) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/^stockfish/i.test(e.name) && (exe ? e.name.toLowerCase().endsWith('.exe') : !path.extname(e.name))) {
        found.push(p);
      }
    }
  };
  walk(dir);
  // Самый крупный файл — это собственно движок, а не вспомогательные скрипты.
  found.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return found[0] || null;
}

// ─────────────────────────────────────────────────────────── UCI-проба

const SIGILL_EXIT = -1073741795; // 0xC000001D: STATUS_ILLEGAL_INSTRUCTION

/**
 * Минимальная самодостаточная UCI-проба. Намеренно не импортирует src/engine/uci.mjs:
 * скрипт установки обязан работать до того, как в проекте появится всё остальное.
 */
const CALIBRATION_FEN = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';

function probeEngine(exePath, { timeoutMs = 40000, calibrateNodes = 400_000, args = [] } = {}) {
  return new Promise((resolve) => {
    const child = spawn(exePath, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: path.dirname(exePath),
    });

    let buf = '';
    let name = null;
    let nps = null;
    let calibT0 = 0;
    let stage = 'uci';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.write('quit\n');
      } catch {}
      setTimeout(() => child.kill(), 300);
      resolve(result);
    };

    const timer = setTimeout(() => finish({ ok: false, error: `таймаут ${timeoutMs} мс на стадии ${stage}` }), timeoutMs);

    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('exit', (code) =>
      finish({ ok: false, error: code === SIGILL_EXIT ? 'SIGILL' : `движок вышел с кодом ${code}` }),
    );

    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (line.startsWith('id name ')) name = line.slice(8).trim();

        if (line === 'uciok' && stage === 'uci') {
          stage = 'ready';
          child.stdin.write('setoption name Threads value 1\nsetoption name Hash value 64\nisready\n');
        } else if (line === 'readyok' && stage === 'ready') {
          // Прогрев отдельным поиском: первый go включает разворачивание NNUE и
          // прогрев предсказателей, и если мерить по нему, скорость занижается.
          stage = 'warmup';
          child.stdin.write('ucinewgame\nposition startpos\ngo nodes 150000\n');
        } else if (line.startsWith('bestmove') && stage === 'warmup') {
          stage = 'calibrate';
          calibT0 = Date.now();
          child.stdin.write(`position fen ${CALIBRATION_FEN}\ngo nodes ${calibrateNodes}\n`);
        } else if (line.startsWith('bestmove') && stage === 'calibrate') {
          const ms = Math.max(1, Date.now() - calibT0);
          nps = Math.round((calibrateNodes / ms) * 1000);
          finish({ ok: true, name, nps });
        }
      }
    });

    child.stdin.write('uci\n');
  });
}

// ─────────────────────────────────────────────────────────── WASM-фолбэк

async function tryWasmFallback() {
  const entryCandidates = [
    'node_modules/stockfish/src/stockfish-nnue-16.js',
    'node_modules/stockfish/src/stockfish-nnue-16-single.js',
    'node_modules/stockfish/src/stockfish.js',
  ];
  const projectRoot = path.resolve(HERE, '..');
  for (const rel of entryCandidates) {
    const abs = path.join(projectRoot, rel);
    if (fs.existsSync(abs)) {
      log(`  найден WASM-движок: ${rel}`);
      // Запускаем отдельным процессом, чтобы uci.mjs / пул / отстрел были теми же.
      const probe = await probeEngine(process.execPath, { timeoutMs: 60000, calibrateNodes: 200000 });
      if (probe.ok) {
        return { kind: 'wasm', path: process.execPath, args: [abs], uciName: probe.name, nps: probe.nps };
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────── основной ход

async function alreadyGood() {
  if (FLAG.force) return null;
  const cur = readJsonSafe(CURRENT_JSON);
  if (!cur || !cur.path || !fs.existsSync(cur.path)) return null;
  const probe = await probeEngine(cur.path, { args: cur.args || [] });
  if (!probe.ok) {
    warn(`  установленный движок не отвечает (${probe.error}), переустанавливаю`);
    return null;
  }
  // Скорость перемеряем каждый раз: от неё генератор десанта считает свои бюджеты,
  // а машина может стоять на батарее, под троттлингом или под чужой нагрузкой.
  const refreshed = { ...cur, uciName: probe.name || cur.uciName, nps: probe.nps, verifiedAt: new Date().toISOString() };
  writeJsonAtomic(CURRENT_JSON, refreshed);
  return refreshed;
}

async function main() {
  ensureDirs();
  log('NOSTROMO GAMBIT · установка движка');

  const existing = await alreadyGood();
  if (existing) {
    log(`  движок на месте: ${existing.uciName} (${existing.kind})`);
    log(`  путь: ${existing.path}`);
    return 0;
  }

  const skipIsa = new Set();
  let lastError = null;

  for (let step = 0; step < ISA_PREFERENCE.length; step++) {
    let release;
    try {
      release = await resolveRelease();
    } catch (err) {
      lastError = err;
      break;
    }

    const picked = pickAsset(release, skipIsa);
    if (!picked) {
      lastError = new Error('в релизе нет подходящего ассета для этой платформы');
      break;
    }
    const { asset, isa } = picked;
    log(`  релиз ${release.tag_name}, ассет ${asset.name} (${human(asset.size)}, сборка ${isa})`);

    try {
      const { expected, fromApi, fromLock } = resolveExpectedDigest(asset);
      log(`  ожидаемый sha256: ${expected ? expected.slice(0, 16) + '…' : 'нет (--allow-unverified)'}` +
        `${fromApi ? ' [API]' : ''}${fromLock ? ' [lock]' : ''}`);

      const archive = path.join(DOWNLOAD_DIR, asset.name);
      const digest = await fetchAssetWithRetry(asset, archive, expected);
      updateLockFile(asset, digest, release.tag_name);

      const destDir = path.join(ENGINE_DIR, `${release.tag_name}-${path.parse(asset.name).name}`);
      fs.rmSync(destDir, { recursive: true, force: true });
      log('  распаковка…');
      await extract(archive, destDir);

      const exePath = findEngineBinary(destDir);
      if (!exePath) throw new Error(`в распакованном архиве не найден исполняемый файл движка (${destDir})`);
      log(`  бинарь: ${path.relative(ENGINE_DIR, exePath)}`);

      log('  проверка запуском и калибровка…');
      const probe = await probeEngine(exePath);
      if (!probe.ok) {
        if (probe.error === 'SIGILL') {
          warn(`  сборка ${isa} не поддерживается этим процессором, беру следующую`);
          skipIsa.add(isa);
          continue;
        }
        throw new Error(`движок не прошёл UCI-пробу: ${probe.error}`);
      }

      const record = {
        kind: 'native',
        path: exePath,
        args: [],
        tag: release.tag_name,
        asset: asset.name,
        isa,
        uciName: probe.name,
        nps: probe.nps,
        sha256: digest,
        verifiedAt: new Date().toISOString(),
      };
      writeJsonAtomic(path.join(destDir, '.meta.json'), record);
      writeJsonAtomic(CURRENT_JSON, record);
      fs.rmSync(archive, { force: true }); // 81 МБ zip больше не нужен

      log(`  готово: ${probe.name}`);
      log(`  скорость: ${probe.nps ? (probe.nps / 1e6).toFixed(2) + ' Mnps' : 'не измерена'}`);
      log(`  путь: ${exePath}`);
      return 0;
    } catch (err) {
      lastError = err;
      warn(`  ошибка: ${err.message}`);
      break;
    }
  }

  warn('\nНе удалось установить нативный Stockfish.');
  if (lastError) warn(`Причина: ${lastError.message}`);
  warn('Пробую WASM-фолбэк…');
  const wasm = await tryWasmFallback();
  if (wasm) {
    writeJsonAtomic(CURRENT_JSON, { ...wasm, verifiedAt: new Date().toISOString() });
    warn('WASM-движок установлен как запасной. Он в разы медленнее — поиск десанта будет дольше.');
    return 0;
  }
  warn('WASM-фолбэк недоступен. Установите его: npm i stockfish@18.0.8, затем повторите npm run setup');
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

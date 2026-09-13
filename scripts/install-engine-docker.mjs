#!/usr/bin/env node
// Установка Stockfish при сборке Docker-образа.
//
// Почему не `npm run setup`. Он рассчитан на рабочую машину, а на сборщике ломается
// в трёх местах:
//   1. ходит в GitHub API — с общих IP облачных сборщиков лимит в 60 запросов в час
//      исчерпывают чужие сборки;
//   2. ищет ассеты `ubuntu-*.zip|tar`, а в sf_19 Linux-сборки называются
//      `stockfish-linux-*.tar.gz`;
//   3. калибрует скорость на машине сборки, а не той, где будет работать сервер
//      (сервер и так калибрует пул при каждом старте).
//
// Здесь всё закреплено: адрес и sha256. Сборка падает, если архив не совпал
// или бинарь не отвечает по UCI — лучше упавшая сборка, чем сервер без движка.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { ENGINE_DIR, CURRENT_JSON, ensureDirs, writeJsonAtomic } from '../src/shared/paths.mjs';

const TAG = 'sf_19';
const ASSETS = {
  x64: {
    name: 'stockfish-linux-x86-64-universal.tar.gz',
    sha256: '9defc0d4e55d49c65a6d042f3e571a39fcea499ade6dbe741b53b8c65e03611f',
  },
  arm64: {
    name: 'stockfish-linux-arm64-universal.tar.gz',
    sha256: 'fe26cfd1d9db4c8af3d21e24d9ff34cacb31c1f940085a7583da11796f2bac01',
  },
};

function fail(message) {
  console.error(`install-engine: ${message}`);
  process.exit(1);
}

async function download(url, target, expectedSha256) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) fail(`не скачалось ${url}: HTTP ${res.status}`);

  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(target);
  for await (const chunk of res.body) {
    hash.update(chunk);
    if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));

  const actual = hash.digest('hex');
  if (actual !== expectedSha256) {
    fs.rmSync(target, { force: true });
    fail(`sha256 не совпал: ожидался ${expectedSha256}, получен ${actual}`);
  }
}

/** Бинарь — самый крупный файл `stockfish*` без расширения: в архиве рядом лежат исходники. */
function findBinary(dir) {
  let best = null;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /^stockfish/i.test(entry.name) && !path.extname(entry.name)) {
        const { size } = fs.statSync(full);
        if (!best || size > best.size) best = { path: full, size };
      }
    }
  };
  walk(dir);
  return best?.path || null;
}

/** Запускает движок, ждёт `uciok` и возвращает имя из `id name`. */
function probeUci(exePath, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let name = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`нет uciok за ${timeoutMs} мс`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.startsWith('id name ')) name = line.slice('id name '.length);
        if (line === 'uciok') {
          clearTimeout(timer);
          child.stdin.write('quit\n');
          resolve(name || 'Stockfish');
        }
      }
    });
    child.stdin.write('uci\n');
  });
}

async function main() {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  if (process.platform !== 'linux' || !arch) {
    fail(`скрипт для Linux x64/arm64, а здесь ${process.platform}/${process.arch}. Локально — npm run setup`);
  }
  const asset = ASSETS[arch];
  const url = `https://github.com/official-stockfish/Stockfish/releases/download/${TAG}/${asset.name}`;

  ensureDirs();
  const destDir = path.join(ENGINE_DIR, `${TAG}-${asset.name.replace(/\.tar\.gz$/, '')}`);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const archive = path.join(destDir, asset.name);

  console.log(`install-engine: ${asset.name}`);
  await download(url, archive, asset.sha256);

  const tar = spawnSync('tar', ['-xzf', asset.name], { cwd: destDir, stdio: 'inherit' });
  if (tar.status !== 0) fail(`tar завершился с кодом ${tar.status}`);
  fs.rmSync(archive);

  const exePath = findBinary(destDir);
  if (!exePath) fail('в архиве не нашёлся бинарь stockfish');
  fs.chmodSync(exePath, 0o755);

  let uciName;
  try {
    uciName = await probeUci(exePath);
  } catch (err) {
    fail(`бинарь не отвечает по UCI: ${err.message}`);
  }

  writeJsonAtomic(CURRENT_JSON, {
    kind: 'native',
    path: exePath,
    args: [],
    tag: TAG,
    asset: asset.name,
    isa: 'universal',
    uciName,
    sha256: asset.sha256,
    verifiedAt: new Date().toISOString(),
  });
  console.log(`install-engine: ${uciName} → ${exePath}`);
}

main().catch((err) => fail(err.stack || err.message));

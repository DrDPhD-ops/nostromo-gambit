// Реестр запущенных процессов движка.
//
// Зачем: `quit`, `kill()` и обработчики сигналов спасают только при штатном
// завершении. Закрытое окно терминала, Task Manager и синий экран оставляют
// stockfish.exe жить и жрать ядро. Единственная защита от этого — файл с PID'ами,
// вычищаемый при СЛЕДУЮЩЕМ старте.
//
// Файл заведён на каждый процесс-владелец. Один общий файл означал бы
// read-modify-write из нескольких процессов без блокировки: сервер, ночной прогон
// и параллельные тестовые файлы затирали бы записи друг друга.
//
// Сопоставляем не только по PID (их переиспользует ОС), но и по пути к образу:
// если PID успел достаться чужому процессу, путь не совпадёт и мы его не тронем.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureDirs, pidRegistryFile, listPidRegistryFiles } from '../shared/paths.mjs';

const isWindows = process.platform === 'win32';

function readFileEntries(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeOwnEntries(entries) {
  ensureDirs();
  const file = pidRegistryFile();
  const body = entries.map((e) => JSON.stringify(e)).join('\n');
  if (entries.length === 0) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* нечего убирать */
    }
    return;
  }
  fs.writeFileSync(file, `${body}\n`, 'utf8');
}

export function recordPid(pid, exePath) {
  if (!pid) return;
  const entries = readFileEntries(pidRegistryFile()).filter((e) => e.pid !== pid);
  entries.push({ pid, exe: path.resolve(exePath), at: Date.now() });
  writeOwnEntries(entries);
}

export function forgetPid(pid) {
  if (!pid) return;
  writeOwnEntries(readFileEntries(pidRegistryFile()).filter((e) => e.pid !== pid));
}

/** Синхронно, потому что вызывается из process.on('exit'), где промисы уже не работают. */
export function killTreeSync(pid) {
  if (!pid) return;
  try {
    if (isWindows) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch {
    /* процесса уже нет — это и есть желаемый результат */
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM'; // существует, но не наш — всё равно жив
  }
}

/** Живые процессы с их путями к образу: {pid -> exePath}. */
function liveProcesses() {
  const map = new Map();
  if (!isWindows) return map;
  const res = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress',
    ],
    { windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (res.status !== 0 || !res.stdout) return map;
  try {
    const rows = JSON.parse(res.stdout);
    for (const r of Array.isArray(rows) ? rows : [rows]) {
      if (r && r.ProcessId) map.set(Number(r.ProcessId), r.ExecutablePath || '');
    }
  } catch {
    /* не разобрали — считаем, что живых не нашли, и никого не трогаем */
  }
  return map;
}

/**
 * Убивает движки, оставшиеся от прошлых запусков. Вызывать один раз при старте.
 * Возвращает список отстрелянных PID'ов — по нему написан тест.
 */
export function reapOrphans({ verbose = false } = {}) {
  const own = pidRegistryFile();
  const files = listPidRegistryFiles().filter((e) => e.file !== own);
  if (files.length === 0) return [];

  let live = null; // дорогой запрос делаем только если есть что отстреливать
  const killed = [];

  for (const { file, owner } of files) {
    const entries = readFileEntries(file);
    const ownerAlive = processAlive(owner);
    if (ownerAlive) continue; // чужой живой процесс сам разберётся со своими детьми

    if (live === null) live = liveProcesses();
    for (const e of entries) {
      const exe = live.get(e.pid);
      if (exe === undefined) continue; // процесса нет — запись устарела
      const sameImage = exe && path.resolve(exe).toLowerCase() === path.resolve(e.exe).toLowerCase();
      if (!sameImage) continue; // PID переиспользован чужим процессом — не наш
      killTreeSync(e.pid);
      killed.push(e.pid);
      if (verbose) console.warn(`  отстрелян осиротевший движок PID ${e.pid} (владелец ${owner} мёртв)`);
    }
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* файл мог исчезнуть сам */
    }
  }
  return killed;
}

/** Для тестов: какие PID'ы этот процесс считает своими прямо сейчас. */
export function registeredPids() {
  return readFileEntries(pidRegistryFile()).map((e) => e.pid);
}

/** Аварийная уборка: убить всё своё синхронно. Для process.on('exit'). */
export function killOwnEnginesSync() {
  for (const e of readFileEntries(pidRegistryFile())) killTreeSync(e.pid);
  writeOwnEntries([]);
}

// Все рантайм-артефакты живут в %LOCALAPPDATA%, а не рядом с исходниками.
// Причина зафиксирована в плане: каталог проекта пользователя лежит на виртуальном
// диске Google Drive, где npm-распаковка даёт файлы нулевой длины, junction'ы
// не создаются, а событий файловой системы можно не дождаться.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const APP = 'nostromo-gambit';

function baseDir() {
  if (process.env.NOSTROMO_HOME) return path.resolve(process.env.NOSTROMO_HOME);
  const local =
    process.env.LOCALAPPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.local', 'share'));
  return path.join(local, APP);
}

export const ROOT = baseDir();
export const ENGINE_DIR = path.join(ROOT, 'engine');
export const DOWNLOAD_DIR = path.join(ROOT, 'downloads');
export const SELFPLAY_DIR = path.join(ROOT, 'selfplay');
export const CURRENT_JSON = path.join(ENGINE_DIR, 'current.json');
export const RELEASE_CACHE = path.join(ROOT, 'release-cache.json');
export const SESSION_FILE = path.join(ROOT, 'session.json');

/**
 * Реестр PID'ов — файл НА КАЖДЫЙ процесс-владелец, а не один общий.
 * Общий файл — это read-modify-write из нескольких процессов без блокировки:
 * сервер, ночной прогон и параллельные тестовые файлы затирали бы записи друг друга,
 * и в реестре оставались бы призраки, которых потом кто-то попытается отстрелить.
 */
export const PID_REGISTRY_PREFIX = 'engines.';
export const PID_REGISTRY_SUFFIX = '.pid';
export function pidRegistryFile(ownerPid = process.pid) {
  return path.join(ROOT, `${PID_REGISTRY_PREFIX}${ownerPid}${PID_REGISTRY_SUFFIX}`);
}
export function listPidRegistryFiles() {
  try {
    return fs
      .readdirSync(ROOT)
      .filter((f) => f.startsWith(PID_REGISTRY_PREFIX) && f.endsWith(PID_REGISTRY_SUFFIX))
      .map((f) => ({
        file: path.join(ROOT, f),
        owner: Number(f.slice(PID_REGISTRY_PREFIX.length, -PID_REGISTRY_SUFFIX.length)),
      }))
      .filter((e) => Number.isFinite(e.owner));
  } catch {
    return [];
  }
}

export function ensureDirs() {
  for (const d of [ROOT, ENGINE_DIR, DOWNLOAD_DIR, SELFPLAY_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return ROOT;
}

/** Атомарная запись: пишем во временный файл рядом, потом переименовываем. */
export function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

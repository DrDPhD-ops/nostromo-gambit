#!/usr/bin/env node
// Зеркалирование исходников в каталог проекта на диске G:.
//
// Почему рабочая копия не там: G: — виртуальный том Google Drive. Проверено на месте:
// npm install создаёт там файлы НУЛЕВОЙ длины (npm ловит TAR_ENTRY_ERROR и продолжает),
// junction'ы не создаются («требуется локальный том NTFS»), а события файловой системы
// теряются. Наши собственные записи туда проходят нормально, поэтому исходники зеркалим,
// а сборка и запуск живут на C:.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DST = process.env.NOSTROMO_MIRROR || 'G:\\Другие компьютеры\\PAULEKMAN\\dev\\nostromo-gambit';

const SKIP_DIRS = new Set(['node_modules', '.git', 'artifacts']);
const SKIP_FILES = new Set(['.DS_Store']);

let copied = 0;
let skipped = 0;
const failures = [];

function mirror(relDir = '') {
  const from = path.join(SRC, relDir);
  const to = path.join(DST, relDir);
  fs.mkdirSync(to, { recursive: true });

  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      mirror(path.join(relDir, entry.name));
      continue;
    }
    if (SKIP_FILES.has(entry.name)) continue;

    const srcFile = path.join(from, entry.name);
    const dstFile = path.join(to, entry.name);
    const srcStat = fs.statSync(srcFile);
    try {
      const dstStat = fs.statSync(dstFile);
      if (dstStat.size === srcStat.size && dstStat.mtimeMs >= srcStat.mtimeMs) {
        skipped += 1;
        continue;
      }
    } catch {
      /* назначения ещё нет — копируем */
    }
    try {
      fs.copyFileSync(srcFile, dstFile);
      // Диск синхронизируемый: убеждаемся, что файл долетел целиком, а не нулевым.
      const check = fs.statSync(dstFile);
      if (check.size !== srcStat.size) throw new Error(`размер не совпал: ${check.size} вместо ${srcStat.size}`);
      copied += 1;
    } catch (err) {
      failures.push(`${path.join(relDir, entry.name)}: ${err.message}`);
    }
  }
}

mirror();

console.log(`зеркало -> ${DST}`);
console.log(`  скопировано: ${copied}, без изменений: ${skipped}`);
if (failures.length) {
  console.warn(`  НЕ УДАЛОСЬ (${failures.length}):`);
  for (const f of failures.slice(0, 20)) console.warn(`    ${f}`);
  process.exit(1);
}

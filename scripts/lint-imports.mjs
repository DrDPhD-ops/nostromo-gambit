#!/usr/bin/env node
// Ищет импорты, которые никто не использует.
//
// Линтера в проекте нет намеренно (ноль зависимостей сборки), но неиспользуемый
// импорт — это след недоделанной правки, и находить его дешевле машиной.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'artifacts']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

let total = 0;
for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, 'utf8');
  // Тело без строк импорта: иначе имя всегда «используется» в самом импорте.
  const body = src.replace(/^import[\s\S]*?from\s+'[^']+';?\s*$/gm, '');
  const unused = [];
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim();
      if (!name) continue;
      if (!new RegExp(`\\b${name}\\b`).test(body)) unused.push(`${name}  ← ${m[2]}`);
    }
  }
  if (unused.length) {
    total += unused.length;
    console.log(path.relative(ROOT, file).split(path.sep).join('/'));
    for (const u of unused) console.log(`    ${u}`);
  }
}
console.log(`\nнеиспользуемых импортов: ${total}`);
process.exit(total === 0 ? 0 : 1);

#!/usr/bin/env node
// Проверка тестов от противного.
//
// Набор тестов, который проходит и на сломанной программе, хуже, чем его отсутствие:
// он создаёт уверенность, ничего не проверяя. Поэтому здесь в код НАМЕРЕННО вносятся
// дефекты — по одному за раз, — и каждый обязан покрасить набор в красное.
//
// Если какой-то дефект проходит незамеченным, значит соответствующее свойство
// программы не покрыто тестами, и об этом лучше узнать сейчас.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MUTATIONS = [
  {
    name: 'убрать переворот POV для чёрных',
    why: 'оценка в UCI идёт от лица стороны к ходу; без переворота знак дельты систематически врёт',
    file: 'src/engine/evaluate.mjs',
    from: "  return sideToMove === 'w' ? score : flipPov(score);",
    to: '  return score;',
    tests: ['test/unit/evaluate.test.mjs'],
  },
  {
    name: 'не обнулять счётчик 50 ходов при сравнении',
    why: 'Stockfish демпфирует оценку к нулю у порога 50 ходов; сравнение «до/после» смещается сильнее допуска',
    file: 'src/game/fen.mjs',
    from: '  const p = parseFen(fen);\n  p.halfmove = 0;\n  return formatFen(p);',
    to: '  return fen;',
    tests: ['test/unit/fen.test.mjs'],
  },
  {
    name: 'отключить SEE-гейт',
    why: 'без него десант дарит сопернику подвешенные фигуры, а оценка этого не ловит на мелком поиске',
    file: 'src/game/dropRules.mjs',
    from: '    if (loss > o.maxHangingCp) {',
    to: '    if (false && loss > o.maxHangingCp) {',
    tests: ['test/unit/dropRules.test.mjs'],
  },
  {
    name: 'снять правило превращений',
    why: 'позиция «8 пешек + 3 ладьи» недостижима и роняет движок с кодом 1',
    file: 'src/game/fen.mjs',
    from: '    if (side.p + debt > limits.pawnsPerSide) {',
    to: '    if (false && side.p + debt > limits.pawnsPerSide) {',
    tests: ['test/unit/fen.test.mjs', 'test/unit/dropRules.test.mjs'],
  },
  {
    name: 'разрешить десанту ставить шах',
    why: 'десант, объявляющий шах, — это уже не подкрепление, а вмешательство в позицию',
    file: 'src/game/dropRules.mjs',
    from: '  if (o.forbidCheck && movingKing && chess.isAttacked(movingKing, waiting)) {',
    to: '  if (false && movingKing && chess.isAttacked(movingKing, waiting)) {',
    tests: ['test/unit/dropRules.test.mjs'],
  },
  {
    name: 'разрешить пулу выдавать один движок дважды',
    why: 'UCI не мультиплексируется: вторая задача на занятом процессе тихо портит все результаты',
    file: 'src/engine/pool.mjs',
    from: '    return !this.disabled && !this.busy && this.engine && this.engine.alive;',
    to: '    return !this.disabled && this.engine && this.engine.alive;',
    tests: ['test/unit/pool.test.mjs'],
  },
];

function runTests(files) {
  const res = spawnSync(process.execPath, ['--test', ...files], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300000,
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const failMatch = /^# fail (\d+)$/m.exec(out) || /ℹ fail (\d+)/.exec(out);
  const failed = failMatch ? Number(failMatch[1]) : res.status === 0 ? 0 : 1;
  return { failed, status: res.status };
}

console.log('NOSTROMO GAMBIT · проверка тестов от противного\n');
console.log('Сначала убеждаемся, что на нетронутом коде всё зелено.');
const baseline = runTests(['test/unit/evaluate.test.mjs', 'test/unit/fen.test.mjs', 'test/unit/dropRules.test.mjs', 'test/unit/pool.test.mjs']);
if (baseline.failed !== 0) {
  console.error(`  на чистом коде уже ${baseline.failed} падений — сначала почините их`);
  process.exit(1);
}
console.log('  чисто.\n');

let caught = 0;
let missed = 0;

for (const m of MUTATIONS) {
  const abs = path.join(ROOT, m.file);
  const original = fs.readFileSync(abs, 'utf8');

  if (!original.includes(m.from)) {
    console.log(`✖ «${m.name}»`);
    console.log(`    не нашёл место для дефекта в ${m.file} — проверка устарела вместе с кодом`);
    missed += 1;
    continue;
  }

  fs.writeFileSync(abs, original.replace(m.from, m.to), 'utf8');
  let result;
  try {
    result = runTests(m.tests);
  } finally {
    fs.writeFileSync(abs, original, 'utf8'); // восстанавливаем при любом исходе
  }

  if (result.failed > 0) {
    caught += 1;
    console.log(`✔ «${m.name}» — пойман (${result.failed} падений)`);
  } else {
    missed += 1;
    console.log(`✖ «${m.name}» — ПРОШЁЛ НЕЗАМЕЧЕННЫМ`);
    console.log(`    ${m.why}`);
    console.log(`    это свойство не покрыто тестами`);
  }
}

console.log(`\nпойманo ${caught} из ${MUTATIONS.length}`);
process.exit(missed === 0 ? 0 : 1);

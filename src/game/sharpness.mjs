// Измеримые признаки «характера» позиции — то, чего счётчик сантипешек не видит.
//
// Позиция может стоить ровно ноль и быть при этом практически неиграбельной для
// одного из людей: единственный ход, скрытая связка, фигура, которую нечем защитить.
// Эти величины и есть ответ на «хедж против смены шансов, не улавливаемой счётчиком».
//
// МАТЬ их минимизирует, ЭШ максимизирует, БИШОП почти не смотрит.
import { Chess } from 'chess.js';
import { parseFen, formatFen, mirrorSquare, squareIndex } from './fen.mjs';
import { scoreToCp } from '../engine/evaluate.mjs';

/** Подвижность обеих сторон. Для стороны не к ходу очередь хода переставляется. */
export function mobilityBoth(fen) {
  const p = parseFen(fen);
  const asWhite = new Chess(formatFen({ ...p, turn: 'w', ep: '-' }));
  const asBlack = new Chess(formatFen({ ...p, turn: 'b', ep: '-' }));
  return { w: asWhite.moves().length, b: asBlack.moves().length };
}

/** Соседние поля короля плюс его собственное. */
function kingZone(square) {
  const f = 'abcdefgh'.indexOf(square[0]);
  const r = Number(square[1]);
  const out = [];
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      const nf = f + df;
      const nr = r + dr;
      if (nf < 0 || nf > 7 || nr < 1 || nr > 8) continue;
      out.push(`${'abcdefgh'[nf]}${nr}`);
    }
  }
  return out;
}

/** Сколько вражеских фигур смотрит в зону короля каждой из сторон. */
export function kingPressure(fen) {
  const chess = new Chess(fen);
  const out = { w: 0, b: 0 };
  for (const color of ['w', 'b']) {
    const king = chess.findPiece({ type: 'k', color })[0];
    if (!king) continue;
    const enemy = color === 'w' ? 'b' : 'w';
    let count = 0;
    for (const sq of kingZone(king)) count += chess.attackers(sq, enemy).length;
    out[color] = count; // давление НА короля этого цвета
  }
  return out;
}

/**
 * Насколько несимметрично десант изменил давление на королей.
 * Ноль — обе стороны получили поровну; больше нуля — кому-то стало заметно жарче.
 */
export function kingPressureAsymmetry(fenBefore, fenAfter) {
  const a = kingPressure(fenBefore);
  const b = kingPressure(fenAfter);
  const dW = b.w - a.w;
  const dB = b.b - a.b;
  return Math.abs(dW - dB);
}

/** То же для подвижности: перекос прироста возможностей одной из сторон. */
export function mobilityAsymmetry(fenBefore, fenAfter) {
  const a = mobilityBoth(fenBefore);
  const b = mobilityBoth(fenAfter);
  return Math.abs(b.w - a.w - (b.b - a.b));
}

/**
 * Зеркальность расстановки: доля фигур, поставленных на зеркальные поля
 * с фигурой того же типа противоположного цвета. Ровно единица — идеальное зеркало.
 */
export function mirrorScore(placements) {
  if (placements.length === 0) return 0;
  const byIndex = new Map(
    placements.map((p) => [typeof p.square === 'number' ? p.square : squareIndex(p.square), p]),
  );
  let matched = 0;
  for (const [idx, p] of byIndex) {
    const twin = byIndex.get(mirrorSquare(idx));
    if (twin && twin.type === p.type && twin.color !== p.color) matched += 1;
  }
  return matched / placements.length;
}

/**
 * Отрыв лучшего хода от второго, в сантипешках.
 * Большой отрыв означает «единственный ход»: у человека почти нет выбора, и одна
 * ошибка стоит партии. Считается из того же поиска при MultiPV 2 — даром.
 */
export function onlyMoveGap(analysis) {
  if (!analysis || !analysis.multipv) return 0;
  const first = analysis.multipv.get(1);
  const second = analysis.multipv.get(2);
  if (!first || !second) return 0;
  const a = scoreToCp(first.score);
  const b = scoreToCp(second.score);
  if (a === null || b === null) return 0;
  // Оценки в multipv остались в POV стороны к ходу; нам нужна только величина разрыва.
  return Math.max(0, Math.abs(a - b));
}

/**
 * Свод «характера» одного кандидата. Все величины неотрицательны и растут
 * в сторону «острее», кроме зеркальности, которая растёт в сторону «спокойнее».
 */
export function characterOf(fenBefore, fenAfter, placements, analysis) {
  return {
    spread: analysis ? analysis.spread || 0 : 0,
    onlyMove: onlyMoveGap(analysis),
    kingPressure: kingPressureAsymmetry(fenBefore, fenAfter),
    mobility: mobilityAsymmetry(fenBefore, fenAfter),
    mirror: mirrorScore(placements),
  };
}

/**
 * Штраф профиля планировщика. Складывается с |Δ − Δ*| в общей стоимости кандидата.
 * Веса заданы в storytellers.mjs; отрицательный вес означает награду.
 */
export function characterPenalty(character, weights) {
  return (
    weights.spread * character.spread +
    weights.onlyMove * character.onlyMove +
    weights.kingPressure * character.kingPressure +
    weights.mobility * character.mobility +
    weights.mirrorBonus * character.mirror
  );
}

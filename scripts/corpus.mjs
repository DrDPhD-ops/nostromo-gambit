// Корпус позиций для замеров и регрессий.
//
// Позиции получаются полуслучайной игрой с уклоном во взятия: нам нужны положения,
// где на доске УЖЕ есть свободные слоты, потому что при 32 фигурах десант невозможен
// в принципе. Это не искусственное ограничение теста — это правило самой игры.
import { Chess } from 'chess.js';
import { makeRng } from '../src/game/rng.mjs';
import { freeSlots, countMaterial } from '../src/game/fen.mjs';
import { enginePositionProblem } from '../src/game/dropRules.mjs';

/** Несколько закреплённых позиций: их поведение не должно меняться от сида. */
export const FIXED_POSITIONS = [
  { label: 'старт (трюм полон)', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
  { label: 'дебют, размен на e5', fen: 'r1bqkb1r/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 5' },
  { label: 'миттельшпиль без ферзей', fen: 'r4rk1/pp3ppp/2n5/2pp4/8/2P1PN2/PP3PPP/R4RK1 w - - 0 18' },
  { label: 'ладейный эндшпиль', fen: '8/5pk1/6p1/7p/7P/5PK1/6P1/8 w - - 0 40' },
  // Ферзь на e2 и чёрный король на e6 по открытой вертикали — это шах стороне,
  // которая НЕ ходит, то есть позиция, которой не бывает. Ферзь убран на d2.
  { label: 'ферзь против ладьи', fen: '8/8/4k3/8/8/3K4/3Q4/5r2 w - - 0 55' },
  { label: 'острая позиция с шахом', fen: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3' },
  { label: 'много рокировочных прав', fen: 'r3k2r/pppq1ppp/2n5/3pp3/3PP3/2N5/PPPQ1PPP/R3K2R w KQkq - 4 10' },
  { label: 'счётчик 50 ходов высоко', fen: '8/5pk1/6p1/7p/7P/5PK1/6P1/8 w - - 84 90' },
];

/**
 * Полуслучайная партия: с вероятностью captureBias выбираем взятие, иначе любой ход.
 * Так доска пустеет быстрее, и мы получаем позиции с реальными свободными слотами.
 */
export function randomPosition(rng, { minSlots = 4, maxPlies = 80 } = {}) {
  const chess = new Chess();
  const plies = rng.int(12, maxPlies);
  for (let i = 0; i < plies; i++) {
    if (chess.isGameOver()) break;
    const moves = chess.moves({ verbose: true });
    if (moves.length === 0) break;
    const captures = moves.filter((m) => m.captured);
    const pool = captures.length > 0 && rng.float() < 0.55 ? captures : moves;
    chess.move(rng.pick(pool));
    if (freeSlots(chess.fen()) >= minSlots && i > 10 && !chess.isCheck() && rng.float() < 0.25) break;
  }
  return chess.fen();
}

export function buildCorpus({ seed = 'corpus', count = 20, minSlots = 4 } = {}) {
  const rng = makeRng(seed);

  // Ни одна позиция корпуса не должна быть нелегальной: движок на таких падает,
  // и вместо замера качества десанта получается замер живучести пула.
  // Написанные от руки позиции проверяются наравне со случайными.
  const bad = FIXED_POSITIONS.map((p) => [p.label, enginePositionProblem(p.fen)]).filter(([, e]) => e);
  if (bad.length) {
    throw new Error(
      `В корпусе нелегальные позиции:\n${bad.map(([l, e]) => `  ${l}: ${e}`).join('\n')}`,
    );
  }

  const out = FIXED_POSITIONS.map((p) => ({ ...p, slots: freeSlots(p.fen), pieces: countMaterial(p.fen).total }));

  let guard = 0;
  while (out.length < count && guard < count * 40) {
    guard += 1;
    const fen = randomPosition(rng, { minSlots });
    const chess = new Chess(fen);
    if (chess.isGameOver()) continue;
    const slots = freeSlots(fen);
    if (slots < minSlots) continue;
    if (out.some((p) => p.fen === fen)) continue;
    if (enginePositionProblem(fen)) continue;
    out.push({ label: `случайная #${out.length + 1}`, fen, slots, pieces: countMaterial(fen).total });
  }
  return out.slice(0, count);
}

// Компьютерный игрок: тот же Stockfish, но с намеренно ослабленной игрой.
//
// Ослабление сделано не понижением глубины «в лоб», а сочетанием бюджета узлов
// и выбора не всегда лучшего хода из MultiPV. Причина: движок, которому просто
// урезали глубину, играет не слабее, а страннее — он по-прежнему видит тактику
// на два хода и всё так же не зевает, зато перестаёт понимать план. Выбор из
// нескольких лучших ходов даёт более человеческую и более приятную игру.
import { Chess } from 'chess.js';
import { scoreToCp } from '../engine/evaluate.mjs';

export const LEVELS = [
  {
    id: 1,
    name: 'РЯДОВОЙ',
    blurb: 'Смотрит недалеко и охотно берёт второй по силе ход.',
    nodes: 30000,
    multipv: 4,
    slackCp: 220,
  },
  { id: 2, name: 'КАПРАЛ', blurb: 'Считает заметно лучше, но всё ещё ошибается.', nodes: 90000, multipv: 3, slackCp: 130 },
  { id: 3, name: 'СЕРЖАНТ', blurb: 'Крепкая игра, редкие неточности.', nodes: 260000, multipv: 2, slackCp: 60 },
  { id: 4, name: 'ЛЕЙТЕНАНТ', blurb: 'Играет всерьёз, поблажек не делает.', nodes: 700000, multipv: 2, slackCp: 20 },
  { id: 5, name: 'MU-TH-UR 6000', blurb: 'Полная сила на этой машине. Удачи.', nodes: 2000000, multipv: 1, slackCp: 0 },
];

export function getLevel(id) {
  return LEVELS.find((l) => l.id === Number(id)) || LEVELS[2];
}

export function levelList() {
  return LEVELS.map(({ id, name, blurb }) => ({ id, name, blurb }));
}

/**
 * Выбирает ход за компьютер.
 * @returns {{from:string,to:string,promotion?:string,san:string,cp:number|null}|null}
 */
export async function chooseComputerMove(pool, fen, { level = 3, rng = null, signal = null } = {}) {
  const profile = getLevel(level);
  const analysis = await pool.analyse(
    { fen, nodes: profile.nodes, multipv: profile.multipv, newGame: true },
    { priority: 'urgent', signal },
  );

  // Собираем кандидатов из MultiPV: первый ход каждой линии плюс bestmove как запасной.
  const chess = new Chess(fen);
  const legal = chess.moves({ verbose: true });
  const byUci = new Map(legal.map((m) => [`${m.from}${m.to}${m.promotion || ''}`, m]));

  const candidates = [];
  for (const [idx, line] of analysis.multipv) {
    const uci = line.pv && line.pv[0];
    if (!uci) continue;
    const move = byUci.get(uci) || byUci.get(uci.slice(0, 4));
    if (!move) continue;
    candidates.push({ move, cp: scoreToCp(line.score), rank: idx });
  }
  if (candidates.length === 0 && analysis.best) {
    const move = byUci.get(analysis.best) || byUci.get(analysis.best.slice(0, 4));
    if (move) candidates.push({ move, cp: scoreToCp(analysis.score), rank: 1 });
  }
  if (candidates.length === 0) {
    // Движок не дал ничего пригодного — берём любой легальный ход, лишь бы партия шла.
    if (legal.length === 0) return null;
    const m = rng ? rng.pick(legal) : legal[0];
    return { from: m.from, to: m.to, promotion: m.promotion, san: m.san, cp: null };
  }

  candidates.sort((a, b) => a.rank - b.rank);
  const bestCp = candidates[0].cp ?? 0;
  // Берём только те ходы, что не хуже лучшего больше чем на slackCp: даже слабый
  // уровень не должен «дарить» ферзя, иначе играть с ним неинтересно.
  const acceptable = candidates.filter((c) => (c.cp ?? bestCp) >= bestCp - profile.slackCp);
  const pick = rng ? rng.pick(acceptable) : acceptable[0];

  return {
    from: pick.move.from,
    to: pick.move.to,
    promotion: pick.move.promotion,
    san: pick.move.san,
    cp: pick.cp,
    level: profile.id,
  };
}

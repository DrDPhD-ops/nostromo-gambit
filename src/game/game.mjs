// Машина состояний партии.
//
// Главное решение этого файла продиктовано проверенной находкой: `chess.js` 1.4.0
// в `load()` вызывает `clear()` и стирает свою внутреннюю историю. Десант обязан
// пересобирать позицию из FEN, поэтому опираться на историю chess.js через десант
// нельзя — молча пропали бы отмена хода, список ходов и троекратное повторение.
//
// Поэтому Game ведёт СВОЙ журнал атомов (ход или десант) и стек снимков FEN,
// а chess.js используется только как генератор ходов для ТЕКУЩЕЙ позиции.
import { Chess } from 'chess.js';
import { materialBalance, countMaterial, freeSlots, squareName } from './fen.mjs';
import { getStoryteller, DEFAULT_STORYTELLER } from './storytellers.mjs';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const DEFAULT_SETTINGS = {
  storyteller: DEFAULT_STORYTELLER,
  /** Кто сидит за каждой стороной: 'human' или 'computer'. */
  players: { w: 'human', b: 'human' },
  computerLevel: 3,
  /** 'standard' или 'fischer' (расстановка 960, рокировка выключена). */
  startPosition: 'standard',
  /** 0 отключает автоматический десант. */
  autoDropEveryFullMoves: null, // null = взять из профиля планировщика
  diceRollsPerPlayer: 3,
  showEval: true,
  pieceSet: 'xeno', // 'xeno' | 'classic'
  pieceBadges: true,
  allowNearPromotion: false,
  forbidCheckOnDrop: true,
  toleranceOverride: null,
  seed: null,
};

const GAME_OVER_TEXT = {
  checkmate: 'МАТ',
  stalemate: 'ПАТ',
  insufficient_material: 'НИЧЬЯ: НЕДОСТАТОЧНО МАТЕРИАЛА',
  threefold: 'НИЧЬЯ: ТРОЕКРАТНОЕ ПОВТОРЕНИЕ',
  fifty_move: 'НИЧЬЯ: ПРАВИЛО 50 ХОДОВ',
};

let nextPieceId = 1;

export class Game {
  constructor({ settings = {}, fen = START_FEN, seed = null } = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.seed = seed || this.settings.seed || `game-${Date.now()}`;
    this.startFen = fen;
    this.reset(fen);
  }

  reset(fen = START_FEN) {
    this.chess = new Chess(fen);
    this.version = 0;
    this.atoms = [];
    this.snapshots = [fen];
    this.dropLog = [];
    this.moveLog = [];
    this.dice = { w: this.settings.diceRollsPerPlayer, b: this.settings.diceRollsPerPlayer };
    this.ledgerCp = 0;
    this.movesSinceDrop = 0;
    this.consecutiveSkips = 0;
    this.phase = 'idle';
    this.gameOver = null;
    this.pieces = new Map(); // поле -> {id, type, color}
    for (const sq of this.#occupiedSquares()) {
      const p = this.chess.get(sq);
      this.pieces.set(sq, { id: `p${nextPieceId++}`, type: p.type, color: p.color });
    }
    this.#refreshGameOver();
    return this;
  }

  #occupiedSquares() {
    const out = [];
    for (const row of this.chess.board()) {
      for (const cell of row) if (cell) out.push(cell.square);
    }
    return out;
  }

  get fen() {
    return this.chess.fen();
  }

  get turn() {
    return this.chess.turn();
  }

  get storyteller() {
    return getStoryteller(this.settings.storyteller);
  }

  /** Через сколько ходов сработает автоматический десант. 0 — прямо сейчас, null — выключен. */
  get movesUntilAutoDrop() {
    const every = this.settings.autoDropEveryFullMoves ?? this.storyteller.autoEveryFullMoves;
    if (!every || every <= 0) return null;
    return Math.max(0, every - this.movesSinceDrop);
  }

  get autoDropDue() {
    const left = this.movesUntilAutoDrop;
    return left === 0;
  }

  // ───────────────────────────────────────────────── карта легальных ходов

  legalMovesMap() {
    const map = {};
    if (this.gameOver) return map;
    for (const m of this.chess.moves({ verbose: true })) {
      (map[m.from] ||= []).push(m.to);
    }
    for (const k of Object.keys(map)) map[k] = [...new Set(map[k])];
    return map;
  }

  /** Требуется ли выбор фигуры превращения для этого хода. */
  needsPromotion(from, to) {
    return this.chess
      .moves({ verbose: true })
      .some((m) => m.from === from && m.to === to && m.flags.includes('p'));
  }

  // ───────────────────────────────────────────────── ходы

  move({ from, to, promotion }) {
    if (this.gameOver) return { ok: false, code: 'GAME_OVER', message: 'ПАРТИЯ ОКОНЧЕНА' };
    if (this.phase === 'dropping') {
      return { ok: false, code: 'DROP_IN_PROGRESS', message: 'ИДЁТ ВЫСАДКА — ПОДОЖДИТЕ' };
    }
    if (!promotion && this.needsPromotion(from, to)) {
      return { ok: false, code: 'PROMOTION_REQUIRED', message: 'ВЫБЕРИТЕ ФИГУРУ ПРЕВРАЩЕНИЯ' };
    }

    let made;
    try {
      made = this.chess.move({ from, to, promotion: promotion || undefined });
    } catch {
      made = null;
    }
    if (!made) return { ok: false, code: 'ILLEGAL_MOVE', message: 'ТАКОЙ ХОД НЕВОЗМОЖЕН' };

    this.#applyPieceMove(made);

    this.atoms.push({ kind: 'move', san: made.san, from: made.from, to: made.to, promotion: made.promotion });
    this.snapshots.push(this.chess.fen());
    this.moveLog.push({
      ply: this.moveLog.length + 1,
      n: Math.floor(this.moveLog.length / 2) + 1,
      color: made.color,
      san: made.san,
      from: made.from,
      to: made.to,
      promotion: made.promotion || null,
      captured: made.captured || null,
      fenAfter: this.chess.fen(),
    });
    // Счётчик авто-десанта считает ПОЛНЫЕ ходы: подкрепление приходит после хода чёрных,
    // иначе одна из сторон систематически получала бы его первой.
    if (made.color === 'b') this.movesSinceDrop += 1;
    this.version += 1;
    this.#refreshGameOver();
    return { ok: true, move: made, version: this.version };
  }

  /**
   * Обновление идентификаторов фигур. Их нельзя вычислить сравнением позиций «до»
   * и «после»: две одинаковые фигуры на соседних полях неразличимы. Поэтому
   * применяем семантику самого хода — по этим идентификаторам клиент анимирует
   * перемещение, а не перерисовку.
   */
  #applyPieceMove(m) {
    const moving = this.pieces.get(m.from);
    this.pieces.delete(m.from);

    if (m.flags.includes('e')) {
      // Взятие на проходе: побитая пешка стоит не на поле назначения.
      const capturedSquare = `${m.to[0]}${m.color === 'w' ? Number(m.to[1]) - 1 : Number(m.to[1]) + 1}`;
      this.pieces.delete(capturedSquare);
    } else if (m.captured) {
      this.pieces.delete(m.to);
    }

    if (moving) {
      this.pieces.set(m.to, { ...moving, type: m.promotion || moving.type });
    }

    if (m.flags.includes('k') || m.flags.includes('q')) {
      const rank = m.color === 'w' ? '1' : '8';
      const [rookFrom, rookTo] = m.flags.includes('k') ? [`h${rank}`, `f${rank}`] : [`a${rank}`, `d${rank}`];
      const rook = this.pieces.get(rookFrom);
      this.pieces.delete(rookFrom);
      if (rook) this.pieces.set(rookTo, rook);
    }
  }

  // ───────────────────────────────────────────────── десант

  /** Результат генератора применяется к позиции целиком. */
  applyDrop(drop) {
    if (!drop || !drop.ok) return { ok: false, code: 'DROP_FAILED', message: 'ВЫСАДКА НЕ СОСТОЯЛАСЬ' };

    // Позиция пересобирается из FEN, и вместе с ней в chess.js обнуляется его
    // собственная история. Наш журнал атомов от этого не страдает — в этом и смысл.
    this.chess.load(drop.fen);

    const landed = [];
    for (const p of drop.placements) {
      const sq = p.squareName || squareName(p.square);
      const entry = { id: `p${nextPieceId++}`, type: p.type, color: p.color };
      this.pieces.set(sq, entry);
      landed.push({ ...entry, square: sq });
    }

    this.ledgerCp += drop.nominalDeltaCp || 0;
    this.movesSinceDrop = 0;
    this.consecutiveSkips = 0;

    const record = {
      id: this.dropLog.length + 1,
      afterPly: this.moveLog.length,
      atMove: Math.floor(this.moveLog.length / 2) + 1,
      trigger: drop.dice ? 'dice' : 'auto',
      dice: drop.dice || null,
      storyteller: drop.storyteller,
      white: landed.filter((p) => p.color === 'w').map((p) => ({ type: p.type, square: p.square })),
      black: landed.filter((p) => p.color === 'b').map((p) => ({ type: p.type, square: p.square })),
      evalBefore: drop.evalBefore,
      evalAfter: drop.evalAfter,
      delta: drop.delta,
      targetDelta: drop.targetDelta,
      error: drop.error,
      toleranceUsed: drop.toleranceUsed,
      toleranceWidened: drop.toleranceWidened,
      searchMs: drop.searchMs,
      packageLabel: drop.package ? drop.package.label : null,
      ledgerCp: this.ledgerCp,
    };
    this.dropLog.push(record);
    this.atoms.push({ kind: 'drop', dropId: record.id, placements: landed });
    this.snapshots.push(this.chess.fen());
    this.version += 1;
    this.#refreshGameOver();
    return { ok: true, drop: record, version: this.version };
  }

  noteSkippedDrop(reason) {
    this.consecutiveSkips += 1;
    this.movesSinceDrop = 0; // счётчик перевзводится, чтобы не долбиться каждый ход
    this.version += 1;
    return { ok: true, reason, version: this.version };
  }

  spendDiceRoll(side) {
    if (this.dice[side] <= 0) return false;
    this.dice[side] -= 1;
    return true;
  }

  refundDiceRoll(side) {
    this.dice[side] = Math.min(this.settings.diceRollsPerPlayer, this.dice[side] + 1);
  }

  // ───────────────────────────────────────────────── отмена

  /**
   * Откат одного атома. Десант откатывается целиком, вместе с записью в журнале
   * и возвратом потраченного жетона — иначе отмена дарила бы бросок.
   */
  undo() {
    if (this.atoms.length === 0) {
      return { ok: false, code: 'NOTHING_TO_UNDO', message: 'ОТМЕНЯТЬ НЕЧЕГО' };
    }
    const atom = this.atoms.pop();
    this.snapshots.pop();
    const restored = this.snapshots[this.snapshots.length - 1];

    if (atom.kind === 'move') {
      this.moveLog.pop();
      if (atom.color === 'b' || this.chess.turn() === 'w') this.movesSinceDrop = Math.max(0, this.movesSinceDrop - 1);
    } else {
      const record = this.dropLog.pop();
      if (record) {
        this.ledgerCp -= record.ledgerCp - (this.dropLog[this.dropLog.length - 1]?.ledgerCp || 0);
        if (record.trigger === 'dice' && record.dice) this.refundDiceRoll(record.dice.side);
      }
    }

    this.chess.load(restored);
    this.#rebuildPieceIds();
    this.version += 1;
    this.#refreshGameOver();
    return { ok: true, version: this.version };
  }

  /**
   * После отката идентификаторы фигур приходится назначать заново: восстановить,
   * какой именно конь стоял на поле три хода назад, из FEN невозможно. Для анимации
   * это означает разовую перерисовку доски, что честнее, чем притворяться.
   */
  #rebuildPieceIds() {
    this.pieces = new Map();
    for (const sq of this.#occupiedSquares()) {
      const p = this.chess.get(sq);
      this.pieces.set(sq, { id: `p${nextPieceId++}`, type: p.type, color: p.color });
    }
  }

  // ───────────────────────────────────────────────── конец партии

  #refreshGameOver() {
    if (this.chess.isCheckmate()) {
      const winner = this.chess.turn() === 'w' ? 'b' : 'w';
      this.gameOver = {
        reason: 'checkmate',
        winner,
        text: `${GAME_OVER_TEXT.checkmate}. ПОБЕДА ${winner === 'w' ? 'МОРПЕХОВ' : 'КСЕНО'}.`,
      };
    } else if (this.chess.isStalemate()) {
      this.gameOver = { reason: 'stalemate', winner: null, text: GAME_OVER_TEXT.stalemate };
    } else if (this.chess.isInsufficientMaterial()) {
      this.gameOver = { reason: 'insufficient_material', winner: null, text: GAME_OVER_TEXT.insufficient_material };
    } else if (this.chess.isThreefoldRepetition()) {
      this.gameOver = { reason: 'threefold', winner: null, text: GAME_OVER_TEXT.threefold };
    } else if (this.chess.isDrawByFiftyMoves()) {
      this.gameOver = { reason: 'fifty_move', winner: null, text: GAME_OVER_TEXT.fifty_move };
    } else {
      this.gameOver = null;
    }
    this.phase = this.gameOver ? 'over' : this.phase === 'dropping' ? 'dropping' : 'idle';
  }

  // ───────────────────────────────────────────────── снимок для клиента

  snapshot(extra = {}) {
    const board = [];
    for (const [square, piece] of this.pieces) {
      board.push({ square, id: piece.id, type: piece.type, color: piece.color });
    }
    const { total } = countMaterial(this.fen);
    return {
      version: this.version,
      phase: this.phase,
      fen: this.fen,
      turn: this.turn,
      inCheck: this.chess.isCheck(),
      board,
      legalMoves: this.legalMovesMap(),
      gameOver: this.gameOver,
      moveLog: this.moveLog,
      dropLog: this.dropLog,
      dice: this.dice,
      movesUntilAutoDrop: this.movesUntilAutoDrop,
      ledgerCp: this.ledgerCp,
      materialCp: materialBalance(this.fen),
      pieceCount: total,
      freeSlots: freeSlots(this.fen),
      settings: this.settings,
      storyteller: {
        id: this.storyteller.id,
        name: this.storyteller.name,
        codename: this.storyteller.codename,
        blurb: this.storyteller.blurb,
        toleranceCp: this.storyteller.toleranceCp,
      },
      lastDrop: this.dropLog[this.dropLog.length - 1] || null,
      ...extra,
    };
  }

  /** PGN с десантами в виде комментариев — партию должно быть можно перечитать. */
  toPgn() {
    const lines = [];
    let moveNo = 1;
    let buffer = '';
    for (const atom of this.atoms) {
      if (atom.kind === 'move') {
        if (buffer === '') buffer = `${moveNo}. ${atom.san}`;
        else {
          lines.push(`${buffer} ${atom.san}`);
          buffer = '';
          moveNo += 1;
        }
      } else {
        const rec = this.dropLog.find((d) => d.id === atom.dropId);
        const desc = atom.placements.map((p) => `${p.color}${p.type}${p.square}`).join(' ');
        const note = `{ ДЕСАНТ #${atom.dropId}: ${desc}${rec ? ` (Δ ${rec.delta} сп)` : ''} }`;
        if (buffer) {
          lines.push(`${buffer} ${note}`);
          buffer = '';
        } else lines.push(note);
      }
    }
    if (buffer) lines.push(buffer);
    return lines.join('\n');
  }
}

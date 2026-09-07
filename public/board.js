// Доска: 64 статических поля и отдельный слой фигур.
//
// Ключевое решение — поля НИКОГДА не пересоздаются, а фигуры живут в своём слое и
// позиционируются трансформацией. Диффинг по устойчивому идентификатору фигуры,
// который приходит с сервера, — это то, что превращает перерисовку в анимацию:
// и ход, и посадку десанта видно как движение, а не как мигание.
import { spriteSvg, PIECE_LETTER, PIECE_NAME } from './sprites.js';

const FILES = 'abcdefgh';

export function squareName(file, rank) {
  return `${FILES[file]}${rank}`;
}

export class BoardView {
  constructor({ squaresEl, piecesEl, boardEl, onSelect }) {
    this.squaresEl = squaresEl;
    this.piecesEl = piecesEl;
    this.boardEl = boardEl;
    this.onSelect = onSelect;

    this.squares = new Map(); // имя поля -> элемент
    this.pieceEls = new Map(); // идентификатор фигуры -> элемент
    this.selected = null;
    this.legalMoves = {};
    this.board = [];
    this.pieceSet = 'xeno';
    this.badges = true;
    this.locked = false;

    this.#buildSquares();
    this.#bindPointer();
  }

  #buildSquares() {
    const frag = document.createDocumentFragment();
    for (let r = 8; r >= 1; r--) {
      for (let f = 0; f < 8; f++) {
        const name = squareName(f, r);
        const el = document.createElement('div');
        el.className = `sq ${(f + r) % 2 === 0 ? 'dark' : 'light'}`;
        el.dataset.square = name;
        if (f === 0 || r === 1) {
          const c = document.createElement('span');
          c.className = 'coord';
          c.textContent = f === 0 && r === 1 ? name : f === 0 ? String(r) : FILES[f];
          el.appendChild(c);
        }
        this.squares.set(name, el);
        frag.appendChild(el);
      }
    }
    this.squaresEl.appendChild(frag);
  }

  // ─────────────────────────────────────────── ввод

  #squareFromPoint(x, y) {
    const rect = this.boardEl.getBoundingClientRect();
    const f = Math.floor(((x - rect.left) / rect.width) * 8);
    const r = 8 - Math.floor(((y - rect.top) / rect.height) * 8);
    if (f < 0 || f > 7 || r < 1 || r > 8) return null;
    return squareName(f, r);
  }

  /**
   * Указатель, а не нативный drag&drop: последний тащит призрачную картинку,
   * не работает на касании и не даёт управлять анимацией. Плюс поддержан
   * режим «клик по источнику — клик по цели», которым играет большинство.
   */
  #bindPointer() {
    let dragging = null;

    this.boardEl.addEventListener('pointerdown', (ev) => {
      if (this.locked) return;
      const sq = this.#squareFromPoint(ev.clientX, ev.clientY);
      if (!sq) return;

      // Второй клик по подсвеченной цели завершает ход.
      if (this.selected && this.legalMoves[this.selected]?.includes(sq)) {
        this.onSelect({ from: this.selected, to: sq });
        this.clearSelection();
        return;
      }

      const piece = this.board.find((p) => p.square === sq);
      if (!piece || !this.legalMoves[sq]) {
        this.clearSelection();
        return;
      }

      this.select(sq);
      const el = this.pieceEls.get(piece.id);
      if (!el) return;
      dragging = { from: sq, el, pointerId: ev.pointerId, moved: false };
      el.classList.add('dragging');
      this.boardEl.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });

    this.boardEl.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      const rect = this.boardEl.getBoundingClientRect();
      const size = rect.width / 8;
      const x = ev.clientX - rect.left - size / 2;
      const y = ev.clientY - rect.top - size / 2;
      dragging.moved = true;
      dragging.el.style.transform = `translate(${x}px, ${y}px)`;
    });

    const finish = (ev) => {
      if (!dragging) return;
      const { from, el, moved } = dragging;
      dragging = null;
      el.classList.remove('dragging');
      el.style.transform = '';
      this.#placePiece(el, from); // вернём на место; сервер подтвердит настоящий ход
      try {
        this.boardEl.releasePointerCapture(ev.pointerId);
      } catch {
        /* захват мог уже отпуститься сам */
      }
      if (!moved) return; // это был обычный клик — выбор уже сделан
      const to = this.#squareFromPoint(ev.clientX, ev.clientY);
      if (!to || to === from) return;
      if (!this.legalMoves[from]?.includes(to)) return;
      this.onSelect({ from, to });
      this.clearSelection();
    };

    this.boardEl.addEventListener('pointerup', finish);
    this.boardEl.addEventListener('pointercancel', finish);
  }

  select(sq) {
    this.clearSelection();
    this.selected = sq;
    this.squares.get(sq)?.classList.add('sel');
    for (const to of this.legalMoves[sq] || []) {
      const el = this.squares.get(to);
      if (!el) continue;
      el.classList.add('target');
      if (this.board.some((p) => p.square === to)) el.classList.add('capture');
    }
  }

  clearSelection() {
    if (this.selected) this.squares.get(this.selected)?.classList.remove('sel');
    this.selected = null;
    for (const el of this.squares.values()) el.classList.remove('target', 'capture');
  }

  // ─────────────────────────────────────────── отрисовка

  #placePiece(el, square) {
    const f = FILES.indexOf(square[0]);
    const r = Number(square[1]);
    const tx = `${f * 100}%`;
    const ty = `${(8 - r) * 100}%`;
    el.style.setProperty('--tx', tx);
    el.style.setProperty('--ty', ty);
    el.style.transform = `translate(${tx}, ${ty})`;
  }

  #createPiece(p) {
    const el = document.createElement('div');
    el.className = 'piece';
    el.dataset.id = p.id;
    el.dataset.color = p.color;
    el.title = `${p.color === 'w' ? 'морпехи' : 'ксено'}: ${PIECE_NAME[p.type]}`;
    el.innerHTML = spriteSvg(this.pieceSet, p.color, p.type);
    if (this.badges) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = PIECE_LETTER[p.type];
      el.appendChild(b);
    }
    return el;
  }

  /**
   * @param {Array} board       фигуры со стабильными идентификаторами
   * @param {Set}   landedIds   кто именно только что высадился — им играем посадку
   */
  render(board, { legalMoves = {}, lastMove = null, checkSquare = null, reinforced = [], landedIds = null } = {}) {
    this.board = board;
    this.legalMoves = legalMoves;

    const seen = new Set();
    for (const p of board) {
      seen.add(p.id);
      let el = this.pieceEls.get(p.id);
      if (!el) {
        el = this.#createPiece(p);
        this.pieceEls.set(p.id, el);
        this.piecesEl.appendChild(el);
        this.#placePiece(el, p.square);
        if (landedIds && landedIds.has(p.id)) {
          // Порядок важен: сначала позиция, потом класс анимации, иначе
          // переменные --tx/--ty ещё не заданы и фигура прилетает в угол.
          el.classList.add('landing');
          el.addEventListener('animationend', () => el.classList.remove('landing'), { once: true });
        }
      } else {
        const type = el.dataset.type;
        if (type && type !== p.type) el.innerHTML = spriteSvg(this.pieceSet, p.color, p.type);
        this.#placePiece(el, p.square);
      }
      el.dataset.type = p.type;
      el.dataset.square = p.square;
    }

    for (const [id, el] of this.pieceEls) {
      if (seen.has(id)) continue;
      el.remove();
      this.pieceEls.delete(id);
    }

    for (const el of this.squares.values()) el.classList.remove('last', 'check', 'reinforced');
    if (lastMove) {
      this.squares.get(lastMove.from)?.classList.add('last');
      this.squares.get(lastMove.to)?.classList.add('last');
    }
    if (checkSquare) this.squares.get(checkSquare)?.classList.add('check');
    for (const sq of reinforced) this.squares.get(sq)?.classList.add('reinforced');
  }

  /** Ударная волна на полях высадки. */
  shockwave(squares) {
    for (const sq of squares) {
      const el = this.squares.get(sq);
      if (!el) continue;
      const wave = document.createElement('span');
      wave.className = 'shock';
      el.appendChild(wave);
      setTimeout(() => wave.remove(), 500);
    }
  }

  setLocked(locked) {
    this.locked = locked;
    this.boardEl.classList.toggle('busy', locked);
    if (locked) this.clearSelection();
  }

  setPieceSet(name, badges) {
    if (name === this.pieceSet && badges === this.badges) return;
    this.pieceSet = name;
    this.badges = badges;
    // Набор сменился целиком — проще пересоздать слой, чем чинить каждую фигуру.
    for (const el of this.pieceEls.values()) el.remove();
    this.pieceEls.clear();
  }
}

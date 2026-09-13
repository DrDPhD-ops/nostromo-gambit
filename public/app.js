// Склейка: поток событий, отрисовка, ввод.
//
// Клиент намеренно ничего не решает сам: легальность ходов, расписание десанта
// и счёт жетонов живут на сервере и приходят готовыми. Здесь только три вещи —
// отрисовка, ввод указателя и тайминги анимаций.
import { BoardView } from './board.js';
import { PIECE_LETTER } from './sprites.js';

const $ = (id) => document.getElementById(id);

// На внешнем сервере вход по паролю. Когда сессия истекает, сервер отвечает 401
// на любой /api/* — уводим на форму входа, а не оставляем молча сломанную доску.
const rawFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await rawFetch(...args);
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('unauthorized');
  }
  return res;
};

const el = {
  turn: $('turn-line'),
  hold: $('hold-line'),
  auto: $('auto-line'),
  linkDot: $('link-dot'),
  linkText: $('link-text'),
  evalbar: $('evalbar'),
  evalFill: $('eval-fill'),
  evalLabel: $('eval-label'),
  moves: $('moves'),
  drops: $('drops'),
  banner: $('drop-banner'),
  bannerPhase: $('drop-phase'),
  bannerBar: $('drop-bar'),
  pipsW: $('pips-w'),
  pipsB: $('pips-b'),
  rollW: $('roll-w'),
  rollB: $('roll-b'),
  die1: $('die1'),
  die2: $('die2'),
  diceText: $('dice-text'),
  overlay: $('overlay'),
  overTitle: $('over-title'),
  overSub: $('over-sub'),
  promo: $('promo'),
  drawer: $('drawer'),
  toast: $('toast'),
};

let state = null;
let pendingPromotion = null;
let landedIds = new Set();
let reinforcedSquares = [];

const board = new BoardView({
  squaresEl: $('squares'),
  piecesEl: $('pieces'),
  boardEl: $('board'),
  onSelect: onMoveAttempt,
});

// ─────────────────────────────────────────── сеть

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({ ok: false, message: 'НЕЧИТАЕМЫЙ ОТВЕТ' }));
  if (!data.ok) {
    // Устаревшая версия — не ошибка игрока: просто перечитываем состояние.
    if (data.code === 'STALE_VERSION') {
      await refresh();
      return data;
    }
    toast(data.message || 'ОТКАЗАНО');
  }
  return data;
}

async function refresh() {
  const res = await fetch('/api/state');
  applyState(await res.json());
}

function connect() {
  const es = new EventSource('/api/events');

  es.onopen = () => setLink(true);
  es.onerror = () => {
    setLink(false);
    // EventSource не показывает статус ответа. Закрытый поток после ошибки —
    // повод проверить сессию: если она истекла, fetch-обёртка уведёт на вход.
    if (es.readyState === EventSource.CLOSED) refresh().catch(() => {});
  };

  const stateEvents = ['snapshot', 'move', 'settings', 'state'];
  for (const name of stateEvents) {
    es.addEventListener(name, (e) => applyState(JSON.parse(e.data)));
  }

  es.addEventListener('eval', (e) => renderEval(JSON.parse(e.data)));

  es.addEventListener('thinking', (e) => {
    const t = JSON.parse(e.data);
    el.turn.classList.add('thinking');
    el.turn.textContent = (t.side === 'w' ? 'МОРПЕХИ' : 'КСЕНО') + ' ДУМАЮТ · ' + t.level;
  });

  es.addEventListener('dice', (e) => {
    const { roll, text } = JSON.parse(e.data);
    animateDice(roll, text);
  });

  es.addEventListener('drop:start', (e) => {
    applyState(JSON.parse(e.data));
    showBanner(true);
  });

  es.addEventListener('drop:progress', (e) => renderProgress(JSON.parse(e.data)));

  es.addEventListener('drop:done', (e) => {
    const { drop, state: next } = JSON.parse(e.data);
    const squares = [...drop.white, ...drop.black].map((p) => p.square);
    const before = new Set((state?.board || []).map((p) => p.id));
    landedIds = new Set(next.board.filter((p) => !before.has(p.id)).map((p) => p.id));
    reinforcedSquares = squares;
    showBanner(false);
    applyState(next);
    board.shockwave(squares);
    toast(dropHeadline(drop));
  });

  es.addEventListener('drop:skipped', (e) => {
    const data = JSON.parse(e.data);
    showBanner(false);
    if (data.state) applyState(data.state);
    toast(`ДЕСАНТ ОТЛОЖЕН: ${String(data.reason || '').toUpperCase()}`);
  });

  return es;
}

function setLink(ok) {
  el.linkDot.classList.toggle('off', !ok);
  el.linkText.textContent = ok ? 'СВЯЗЬ' : 'НЕТ СВЯЗИ';
}

// ─────────────────────────────────────────── отрисовка состояния

function applyState(next) {
  if (!next || typeof next.version !== 'number') return;
  const prev = state;
  state = next;

  if (prev && prev.sessionId && next.sessionId && prev.sessionId !== next.sessionId) {
    toast('СЕРВЕР ПЕРЕЗАПУЩЕН');
  }

  board.setPieceSet(next.settings.pieceSet || 'xeno', next.settings.pieceBadges !== false);

  const last = next.moveLog[next.moveLog.length - 1] || null;
  const kingSquare = next.inCheck
    ? next.board.find((p) => p.type === 'k' && p.color === next.turn)?.square
    : null;

  board.render(next.board, {
    legalMoves: next.phase === 'dropping' ? {} : next.legalMoves,
    lastMove: last ? { from: last.from, to: last.to } : null,
    checkSquare: kingSquare,
    reinforced: reinforcedSquares,
    landedIds,
  });
  landedIds = new Set();
  if (last) reinforcedSquares = [];

  board.setLocked(next.phase === 'dropping' || Boolean(next.gameOver));

  renderHeader(next);
  renderMoves(next);
  renderDrops(next);
  renderControls(next);
  renderGameOver(next);
  if (!next.settings.showEval) {
    el.evalbar.classList.add('hidden');
    el.evalLabel.textContent = '——';
  } else {
    el.evalbar.classList.remove('hidden');
  }
}

function renderHeader(s) {
  el.turn.classList.remove('thinking');
  const seats = s.settings.players || { w: 'human', b: 'human' };
  const who = (c) => (seats[c] === 'computer' ? 'ИИ' : 'ЧЕЛ');
  const side = s.turn === 'w' ? 'МОРПЕХИ' : 'КСЕНО';
  const moveNo = Math.floor(s.moveLog.length / 2) + 1;
  el.turn.textContent = s.gameOver ? 'ПАРТИЯ ОКОНЧЕНА' : `ХОД ${moveNo} · ХОДЯТ ${side}${s.inCheck ? ' · ШАХ' : ''}`;
  el.hold.textContent = `М:${who('w')} К:${who('b')} · ТРЮМ ${s.pieceCount}/32 · СВОБОДНО ${s.freeSlots} · ${s.storyteller.name}`;

  if (s.freeSlots < 2) {
    el.auto.textContent = 'ТРЮМ ПОЛОН — ДЕСАНТ ПОСЛЕ ПЕРВЫХ ПОТЕРЬ';
  } else if (s.movesUntilAutoDrop === null) {
    el.auto.textContent = 'АВТО-ДЕСАНТ ВЫКЛЮЧЕН';
  } else {
    el.auto.textContent = `АВТО-ДЕСАНТ ЧЕРЕЗ ${s.movesUntilAutoDrop} ХОД(ОВ)`;
  }
}

function renderMoves(s) {
  const rows = [];
  const dropAfter = new Map();
  for (const d of s.dropLog) dropAfter.set(d.afterPly, d);

  for (let i = 0; i < s.moveLog.length; i += 2) {
    const w = s.moveLog[i];
    const b = s.moveLog[i + 1];
    rows.push(
      `<div class="row"><span class="n">${w.n}.</span><span>${w.san}</span><span>${b ? b.san : ''}</span></div>`,
    );
    for (const ply of [i + 1, i + 2]) {
      const d = dropAfter.get(ply);
      if (d) rows.push(`<div class="row"><span class="sep">═══ ДЕСАНТ #${d.id} ═══</span></div>`);
    }
  }
  const zero = dropAfter.get(0);
  if (zero) rows.unshift(`<div class="row"><span class="sep">═══ ДЕСАНТ #${zero.id} ═══</span></div>`);
  el.moves.innerHTML = rows.join('') || '<span style="color:var(--phosphor-faint)">Ходов пока нет.</span>';
  el.moves.scrollTop = el.moves.scrollHeight;
}

function pieceList(list) {
  return list.map((p) => `${PIECE_LETTER[p.type]}${p.square}`).join(' ') || '—';
}

function dropHeadline(d) {
  const abs = Math.abs(d.delta);
  return abs <= 15 ? `ДЕСАНТ #${d.id}: БАЛАНС СОХРАНЁН (Δ ${d.delta} СП)` : `ДЕСАНТ #${d.id}: Δ ${d.delta} СП`;
}

function renderDrops(s) {
  if (s.dropLog.length === 0) {
    el.drops.innerHTML = '<div style="color:var(--phosphor-faint)">Высадок ещё не было.</div>';
    return;
  }
  const html = [...s.dropLog]
    .reverse()
    .map((d) => {
      const trigger = d.trigger === 'dice' ? `БРОСОК ${d.dice.d1}+${d.dice.d2}` : 'АВТОМАТИЧЕСКИ';
      const balanced = Math.abs(d.delta) <= 15 ? '<span class="chip">БАЛАНС СОХРАНЁН</span>' : '';
      const widened = d.toleranceWidened
        ? `<div class="warn">ДОПУСК РАСШИРЕН ДО ±${d.toleranceUsed} СП</div>`
        : '';
      const target = d.targetDelta ? ` · ЦЕЛЬ ${d.targetDelta > 0 ? '+' : ''}${d.targetDelta}` : '';
      return `<div class="drop-entry">
        <div class="when">#${d.id} · после ${d.atMove}-го хода · ${trigger}</div>
        <div class="marines">МОРПЕХИ: ${pieceList(d.white)}</div>
        <div class="xeno">КСЕНО: ${pieceList(d.black)}</div>
        <div class="delta">${fmtCp(d.evalBefore)} → ${fmtCp(d.evalAfter)} · Δ ${d.delta} сп${target} · ${(d.searchMs / 1000).toFixed(1)} с</div>
        ${widened}${balanced}
      </div>`;
    })
    .join('');
  el.drops.innerHTML = html;
}

function fmtCp(cp) {
  if (cp === null || cp === undefined) return '—';
  const v = cp / 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
}

function renderControls(s) {
  const pips = (n, max) => '●'.repeat(n) + '○'.repeat(Math.max(0, max - n));
  const max = s.settings.diceRollsPerPlayer;
  el.pipsW.textContent = pips(s.dice.w, max);
  el.pipsB.textContent = pips(s.dice.b, max);

  const busy = s.phase === 'dropping' || Boolean(s.gameOver);
  for (const [side, btn] of [
    ['w', el.rollW],
    ['b', el.rollB],
  ]) {
    const seat = (s.settings.players || {})[side] || 'human';
    const can = !busy && seat === 'human' && s.turn === side && s.dice[side] > 0;
    btn.disabled = !can;
    btn.setAttribute('aria-disabled', String(!can));
    btn.title = seat === 'computer'
      ? 'За эту сторону играет компьютер'
      : busy
      ? 'Идёт высадка'
      : s.turn !== side
        ? 'Сейчас не ваш ход'
        : s.dice[side] <= 0
          ? 'Броски закончились'
          : 'Подкрепление получат обе стороны, но ход останется за вами';
  }
  $('btn-undo').disabled = s.phase === 'dropping' || s.moveLog.length + s.dropLog.length === 0;
}

function renderGameOver(s) {
  if (!s.gameOver) {
    el.overlay.classList.remove('on');
    return;
  }
  el.overTitle.textContent = s.gameOver.text.split('.')[0];
  el.overSub.textContent = `Ходов: ${s.moveLog.length} · Десантов: ${s.dropLog.length} · Фигур на доске: ${s.pieceCount}`;
  el.overlay.classList.add('on');
}

// ─────────────────────────────────────────── шкала оценки

function renderEval(e) {
  if (!state || !state.settings.showEval) return;
  const cp = e.scoreCp ?? 0;
  // Логистическое отображение: линейное бесполезно, на нём интересный диапазон
  // ±80 сп неразличим, а ±1500 упирается в край.
  const p = e.mate !== null && e.mate !== undefined ? (e.mate > 0 ? 0.98 : 0.02) : 1 / (1 + Math.exp(-cp / 350));
  el.evalFill.style.height = `${(p * 100).toFixed(1)}%`;
  el.evalFill.style.width = `${(p * 100).toFixed(1)}%`;
  el.evalLabel.textContent =
    e.mate !== null && e.mate !== undefined ? `${e.mate < 0 ? '-' : ''}M${Math.abs(e.mate)}` : fmtCp(cp);
  el.evalbar.classList.toggle('shallow', (e.depth || 0) < 12);
}

// ─────────────────────────────────────────── десант

const PHASE_TEXT = {
  baseline: 'АНАЛИЗ СЕКТОРА…',
  table: 'РАСЧЁТ ТРАЕКТОРИЙ…',
  screen: 'ОТБОР ВАРИАНТОВ ВЫСАДКИ…',
  verify: 'ПОДТВЕРЖДЕНИЕ НА ГЛУБИНЕ…',
};

function showBanner(on) {
  el.banner.classList.toggle('on', on);
  // Текст фазы сбрасывается при скрытии: иначе следующая высадка на мгновение
  // показывает прошлую строку, пока не придёт первое событие прогресса.
  if (!on) el.bannerPhase.textContent = PHASE_TEXT.baseline;
  if (on) {
    el.bannerBar.style.width = '0%';
    el.bannerPhase.textContent = PHASE_TEXT.baseline;
  }
}

function renderProgress(p) {
  el.bannerPhase.textContent = `${PHASE_TEXT[p.phase] || p.phase} ${p.total > 1 ? `${p.done}/${p.total}` : ''}`;
  const weight = { baseline: 0.05, table: 0.2, screen: 0.55, verify: 1 };
  const base = { baseline: 0, table: 0.05, screen: 0.2, verify: 0.55 }[p.phase] ?? 0;
  const span = (weight[p.phase] ?? 1) - base;
  const inner = p.total > 0 ? p.done / p.total : 0;
  el.bannerBar.style.width = `${((base + span * inner) * 100).toFixed(0)}%`;
}

// ─────────────────────────────────────────── кубики

const PIP_LAYOUT = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

function drawDie(node, value) {
  node.innerHTML = '';
  const cells = PIP_LAYOUT[value] || [];
  for (let i = 0; i < 9; i++) {
    const cell = document.createElement('span');
    if (cells.includes(i)) {
      const pip = document.createElement('i');
      cell.appendChild(pip);
    }
    node.appendChild(cell);
  }
}

function animateDice(roll, text) {
  el.diceText.textContent = '';
  el.die1.classList.add('rolling');
  el.die2.classList.add('rolling');
  const spin = setInterval(() => {
    drawDie(el.die1, 1 + Math.floor(Math.random() * 6));
    drawDie(el.die2, 1 + Math.floor(Math.random() * 6));
  }, 70);
  setTimeout(() => {
    clearInterval(spin);
    el.die1.classList.remove('rolling');
    el.die2.classList.remove('rolling');
    drawDie(el.die1, roll.d1);
    drawDie(el.die2, roll.d2);
    el.diceText.textContent = text;
  }, 700);
}

// ─────────────────────────────────────────── действия игрока

async function onMoveAttempt({ from, to }) {
  if (!state) return;
  // Превращение решает человек, а не сервер за него.
  const piece = state.board.find((p) => p.square === from);
  const lastRank = piece?.color === 'w' ? '8' : '1';
  if (piece?.type === 'p' && to[1] === lastRank) {
    pendingPromotion = { from, to };
    el.promo.classList.add('on');
    return;
  }
  await post('/api/move', { from, to, version: state.version });
}

function toast(text) {
  el.toast.textContent = text;
  el.toast.classList.add('on');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.toast.classList.remove('on'), 3400);
}

// ─────────────────────────────────────────── настройки

function fillSettings(s) {
  const sel = $('set-teller');
  if (sel.options.length === 0 && s.storytellers) {
    for (const t of s.storytellers) {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = `${t.name} · ${t.codename}`;
      sel.appendChild(o);
    }
  }
  sel.value = s.settings.storyteller;
  $('teller-blurb').textContent = s.storytellers?.find((t) => t.id === sel.value)?.blurb || '';
  $('set-auto').value = s.settings.autoDropEveryFullMoves ?? '';
  $('set-rolls').value = s.settings.diceRollsPerPlayer;
  $('set-tol').value = s.settings.toleranceOverride ?? '';
  $('set-pieces').value = s.settings.pieceSet || 'xeno';
  $('set-badges').checked = s.settings.pieceBadges !== false;
  $('set-eval').checked = s.settings.showEval !== false;
  $('set-check').checked = s.settings.forbidCheckOnDrop !== false;
}

async function pushSettings() {
  const num = (id) => ($(id).value === '' ? null : Number($(id).value));
  await post('/api/settings', {
    storyteller: $('set-teller').value,
    autoDropEveryFullMoves: num('set-auto'),
    diceRollsPerPlayer: Number($('set-rolls').value),
    toleranceOverride: num('set-tol'),
    pieceSet: $('set-pieces').value,
    pieceBadges: $('set-badges').checked,
    showEval: $('set-eval').checked,
    forbidCheckOnDrop: $('set-check').checked,
  });
}

// ─────────────────────────────────────────── привязки

el.rollW.onclick = () => post('/api/roll', { side: 'w', version: state.version });
el.rollB.onclick = () => post('/api/roll', { side: 'b', version: state.version });
$('btn-undo').onclick = () => post('/api/undo', { version: state.version });
$('btn-new').onclick = () => post('/api/new-game', {});
$('over-new').onclick = () => post('/api/new-game', {});
$('over-close').onclick = () => el.overlay.classList.remove('on');

$('btn-settings').onclick = () => {
  fillSettings(state);
  el.drawer.classList.add('on');
};
$('drawer-close').onclick = () => el.drawer.classList.remove('on');
$('set-teller').onchange = (e) => {
  $('teller-blurb').textContent = state.storytellers?.find((t) => t.id === e.target.value)?.blurb || '';
  pushSettings();
};
for (const id of ['set-auto', 'set-rolls', 'set-tol', 'set-pieces', 'set-badges', 'set-eval', 'set-check']) {
  $(id).onchange = pushSettings;
}

for (const btn of document.querySelectorAll('[data-promo]')) {
  btn.onclick = async () => {
    el.promo.classList.remove('on');
    if (!pendingPromotion) return;
    const { from, to } = pendingPromotion;
    pendingPromotion = null;
    await post('/api/move', { from, to, promotion: btn.dataset.promo, version: state.version });
  };
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    el.drawer.classList.remove('on');
    el.promo.classList.remove('on');
    board.clearSelection();
  }
});

// ─────────────────────────────────────────── стартовый экран

const startEl = $('start');

/** Выбор игрока: сегментные переключатели, как в играх той эпохи. */
const choice = {
  pw: 'human',
  pb: 'human',
  level: '3',
  teller: 'bishop',
  start: 'standard',
  rolls: '3',
  auto: '',
};

function segSelect(group, value) {
  const box = document.querySelector(`.seg[data-opt="${group}"]`);
  if (!box) return;
  for (const b of box.querySelectorAll('button')) b.classList.toggle('on', b.dataset.val === value);
  choice[group] = value;
  refreshStartNotes();
}

function refreshStartNotes() {
  const anyComputer = choice.pw === 'computer' || choice.pb === 'computer';
  $('opt-level').classList.toggle('disabled', !anyComputer);
  const level = state?.levels?.find((l) => String(l.id) === choice.level);
  $('level-note').textContent = anyComputer && level ? `${level.name}: ${level.blurb}` : '';
  const teller = state?.storytellers?.find((t) => t.id === choice.teller);
  $('start-teller-note').textContent = teller ? `${teller.name}: ${teller.blurb}` : '';
  $('fischer-note').textContent =
    choice.start === 'fischer'
      ? 'Случайная расстановка по правилам 960. Рокировка в этом режиме отключена: библиотека правил её не поддерживает.'
      : '';
}

function buildStartOptions(s) {
  const levelBox = $('seg-level');
  if (levelBox.children.length === 0 && s.levels) {
    for (const l of s.levels) {
      const b = document.createElement('button');
      b.dataset.val = String(l.id);
      b.textContent = String(l.id);
      b.title = `${l.name}: ${l.blurb}`;
      if (String(l.id) === choice.level) b.classList.add('on');
      levelBox.appendChild(b);
    }
  }
  const tellerBox = $('seg-teller');
  if (tellerBox.children.length === 0 && s.storytellers) {
    for (const t of s.storytellers) {
      const b = document.createElement('button');
      b.dataset.val = t.id;
      b.textContent = t.name;
      b.title = t.blurb;
      if (t.id === choice.teller) b.classList.add('on');
      tellerBox.appendChild(b);
    }
  }
  refreshStartNotes();
}

document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.seg button');
  if (!btn) return;
  const group = btn.parentElement.dataset.opt;
  segSelect(group, btn.dataset.val);
});

const BOOT_LINES = [
  'ВЫЧИСЛИТЕЛЬНЫЙ КОМПЛЕКС · ИНИЦИАЛИЗАЦИЯ',
  'ПРОВЕРКА ТАКТИЧЕСКОГО МОДУЛЯ ......... НОРМА',
  'СВЯЗЬ С АРБИТРОМ БАЛАНСА ............. УСТАНОВЛЕНА',
  'ГОТОВ К ПРИЁМУ ПАРАМЕТРОВ ОПЕРАЦИИ',
];

/** Печать по буквам — ради ощущения загрузки старой игры, не ради информации. */
function bootSequence() {
  const node = $('boot');
  let line = 0;
  let char = 0;
  node.textContent = '';
  const tick = () => {
    if (line >= BOOT_LINES.length) return;
    node.textContent += BOOT_LINES[line][char];
    char += 1;
    if (char >= BOOT_LINES[line].length) {
      node.textContent += '\n';
      line += 1;
      char = 0;
      setTimeout(tick, 120);
    } else {
      setTimeout(tick, 9);
    }
  };
  tick();
}

$('start-go').onclick = async () => {
  const settings = {
    players: { w: choice.pw, b: choice.pb },
    computerLevel: Number(choice.level),
    storyteller: choice.teller,
    startPosition: choice.start,
    diceRollsPerPlayer: Number(choice.rolls),
    autoDropEveryFullMoves: choice.auto === '' ? null : Number(choice.auto),
  };
  startEl.classList.add('off');
  await post('/api/new-game', { settings });
};

function openStartScreen() {
  buildStartOptions(state || {});
  startEl.classList.remove('off');
  bootSequence();
}

// «Новая партия» всегда возвращает к экрану выбора — это и есть привычный
// путь старых игр: сначала параметры, потом операция.
$('btn-new').onclick = openStartScreen;
$('over-new').onclick = () => {
  el.overlay.classList.remove('on');
  openStartScreen();
};

// Кнопка выхода нужна только там, где есть вход: локально маршрута нет, будет 404.
rawFetch('/api/session')
  .then((r) => {
    if (!r.ok) return;
    const btn = $('btn-logout');
    btn.hidden = false;
    btn.onclick = async () => {
      await rawFetch('/api/logout', { method: 'POST' });
      window.location.href = '/login';
    };
  })
  .catch(() => {});

drawDie(el.die1, 1);
drawDie(el.die2, 1);
await refresh();
connect();

// Экран выбора показывается только когда играть ещё нечего.
// Перезагрузка посреди партии не должна накрывать живую доску: состояние живёт
// на сервере и никуда не делось, а единственная кнопка того экрана начала бы
// новую партию и стёрла бы позицию.
const gameInProgress = state && (state.moveLog.length > 0 || state.dropLog.length > 0);
if (gameInProgress) {
  buildStartOptions(state);
  startEl.classList.add('off');
  toast('ПАРТИЯ ВОССТАНОВЛЕНА');
} else {
  openStartScreen();
}

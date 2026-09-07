import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, openStream } from '../helpers/server.mjs';

test('состояние партии отдаётся целиком и сразу', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  const { status, body } = await s.get('/api/state');
  assert.equal(status, 200);
  assert.equal(body.version, 0);
  assert.equal(body.turn, 'w');
  assert.equal(body.board.length, 32);
  assert.equal(body.freeSlots, 0);
  assert.equal(Object.keys(body.legalMoves).length, 10);
  assert.ok(body.storytellers.length === 3);
  assert.ok(body.levels.length === 5);
});

test('ход принимается и тут же уходит в поток событий', async (t) => {
  const s = await startTestServer();
  const stream = await openStream(s.base);
  t.after(() => {
    stream.close();
    return s.close();
  });

  await stream.waitFor((f) => f.event === 'snapshot');
  const res = await s.post('/api/move', { from: 'e2', to: 'e4', version: 0 });
  assert.equal(res.status, 200);

  const moved = await stream.waitFor((f) => f.event === 'move');
  assert.equal(moved.json.version, 1);
  assert.equal(moved.json.moveLog[0].san, 'e4');
  assert.equal(moved.id, 1, 'кадры состояния обязаны нести id — на них держится переподключение');
});

test('устаревшая версия отвергается и сообщает актуальную', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  await s.post('/api/move', { from: 'e2', to: 'e4', version: 0 });
  const stale = await s.post('/api/move', { from: 'd2', to: 'd4', version: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'STALE_VERSION');
  assert.equal(stale.body.version, 1, 'клиент должен узнать, куда догоняться');
});

test('нелегальный ход отвергается с кодом 422, а версия не двигается', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  const bad = await s.post('/api/move', { from: 'e2', to: 'e5', version: 0 });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.code, 'ILLEGAL_MOVE');
  const state = await s.get('/api/state');
  assert.equal(state.body.version, 0);
});

test('две вкладки видят одну и ту же последовательность событий', async (t) => {
  const s = await startTestServer();
  const a = await openStream(s.base);
  const b = await openStream(s.base);
  t.after(() => {
    a.close();
    b.close();
    return s.close();
  });

  await Promise.all([a.waitFor((f) => f.event === 'snapshot'), b.waitFor((f) => f.event === 'snapshot')]);
  await s.post('/api/move', { from: 'e2', to: 'e4', version: 0 });
  await s.post('/api/move', { from: 'e7', to: 'e5', version: 1 });

  const [ma, mb] = await Promise.all([
    a.waitFor((f) => f.event === 'move' && f.json.version === 2),
    b.waitFor((f) => f.event === 'move' && f.json.version === 2),
  ]);
  assert.equal(ma.json.fen, mb.json.fen);
  assert.deepEqual(
    a.events.filter((e) => e.id !== null).map((e) => e.id),
    b.events.filter((e) => e.id !== null).map((e) => e.id),
  );
});

test('заголовки потока запрещают буферизацию и сжатие', async (t) => {
  const s = await startTestServer();
  const stream = await openStream(s.base);
  t.after(() => {
    stream.close();
    return s.close();
  });

  const h = stream.headers;
  assert.match(h.get('content-type'), /text\/event-stream/);
  assert.match(h.get('content-type'), /charset=utf-8/);
  assert.match(h.get('cache-control'), /no-cache/);
  assert.match(h.get('cache-control'), /no-transform/);
  assert.equal(h.get('x-accel-buffering'), 'no');
  assert.equal(h.get('content-encoding'), null, 'поток не должен быть сжат');
});

test('кириллица переживает поток событий', async (t) => {
  const s = await startTestServer();
  const stream = await openStream(s.base);
  t.after(() => {
    stream.close();
    return s.close();
  });

  const snap = await stream.waitFor((f) => f.event === 'snapshot');
  assert.equal(snap.json.storyteller.name, 'БИШОП');
  assert.ok(snap.json.storytellers.some((x) => x.name === 'МАТЬ'));
});

test('Last-Event-ID воспроизводит хвост, а за пределами буфера отдаёт снимок', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  await s.post('/api/move', { from: 'e2', to: 'e4', version: 0 });
  await s.post('/api/move', { from: 'e7', to: 'e5', version: 1 });

  const resumed = await openStream(s.base, { lastEventId: 1 });
  const frame = await resumed.waitFor((f) => f.id !== null);
  assert.equal(frame.id, 2, 'воспроизводится ровно то, что клиент пропустил');
  resumed.close();

  const far = await openStream(s.base, { lastEventId: 9999 });
  const snap = await far.waitFor((f) => f.event === 'snapshot');
  assert.equal(snap.json.version, 2, 'за пределами буфера отдаётся полный снимок');
  far.close();
});

test('броски кубиков исчерпываются и дальше отвергаются', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  // Освобождаем слоты, иначе десант законно откажется на полном трюме.
  await s.post('/api/_test/fen', { fen: 'r4rk1/pp3ppp/2n5/2pp4/8/2P1PN2/PP3PPP/R4RK1 w - - 0 18' });

  let version = (await s.get('/api/state')).body.version;
  for (let i = 0; i < 3; i++) {
    const r = await s.post('/api/roll', { side: 'w', version });
    assert.equal(r.status, 200, `бросок ${i + 1} обязан пройти`);
    // Дожидаемся окончания высадки, чтобы следующий бросок не упёрся в неё.
    for (let wait = 0; wait < 100; wait++) {
      const st = await s.get('/api/state');
      version = st.body.version;
      if (st.body.phase !== 'dropping') break;
      await new Promise((r2) => setTimeout(r2, 50));
    }
    // Ход чёрных после десанта отдаём обратно белым, чтобы бросать мог тот же игрок.
    const st = await s.get('/api/state');
    version = st.body.version;
    if (st.body.turn !== 'w') break;
  }

  const state = await s.get('/api/state');
  const spent = 3 - state.body.dice.w;
  assert.ok(spent >= 1, 'хотя бы один жетон обязан быть потрачен');
});

test('чужой ход бросать нельзя', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const r = await s.post('/api/roll', { side: 'b', version: 0 });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'NOT_YOUR_TURN');
});

test('настройки применяются и рассылаются', async (t) => {
  const s = await startTestServer();
  const stream = await openStream(s.base);
  t.after(() => {
    stream.close();
    return s.close();
  });

  const r = await s.post('/api/settings', { storyteller: 'ash', autoDropEveryFullMoves: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.storyteller, 'ash');
  const pushed = await stream.waitFor((f) => f.event === 'settings');
  assert.equal(pushed.json.storyteller.id, 'ash');
  assert.equal(pushed.json.settings.autoDropEveryFullMoves, 2);
});

test('настройки чистятся от мусора и клампятся', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  const r = await s.post('/api/settings', {
    storyteller: 'несуществующий',
    diceRollsPerPlayer: 999,
    computerLevel: 42,
    players: { w: 'computer', b: 'чтототакое' },
    startPosition: 'чепуха',
    посторонний: 'ключ',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.diceRollsPerPlayer, 9);
  assert.equal(r.body.settings.computerLevel, 5);
  assert.equal(r.body.settings.players.w, 'computer');
  assert.equal(r.body.settings.players.b, 'human', 'непонятное значение приводится к человеку');
  assert.equal(r.body.settings.startPosition, 'standard');
  assert.equal(r.body.settings.посторонний, undefined, 'чужие ключи не должны просачиваться');
});

test('новая партия с расстановкой Фишера отличается от стандартной', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  await s.post('/api/new-game', { settings: { startPosition: 'fischer' }, seed: 'проверка-960' });
  const state = await s.get('/api/state');
  assert.equal(state.body.board.length, 32);
  assert.equal(state.body.fen.split(' ')[2], '-', 'в режиме Фишера рокировка снята');

  // Тот же сид — та же расстановка.
  const first = state.body.fen;
  await s.post('/api/new-game', { settings: { startPosition: 'fischer' }, seed: 'проверка-960' });
  assert.equal((await s.get('/api/state')).body.fen, first);
});

test('отмена возвращает предыдущее состояние', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  const start = (await s.get('/api/state')).body.fen;
  await s.post('/api/move', { from: 'e2', to: 'e4', version: 0 });
  const undone = await s.post('/api/undo', { version: 1 });
  assert.equal(undone.status, 200);
  assert.equal((await s.get('/api/state')).body.fen, start);

  const nothing = await s.post('/api/undo', { version: 2 });
  assert.equal(nothing.status, 409);
  assert.equal(nothing.body.code, 'NOTHING_TO_UNDO');
});

test('выход за пределы каталога не отдаёт файлов', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  for (const p of ['/../package.json', '/..%2Fpackage.json', '/%2e%2e/package.json']) {
    const res = await fetch(s.base + p);
    assert.ok(res.status === 400 || res.status === 404, `${p} обязан быть отвергнут, а не отдан`);
    const text = await res.text();
    assert.ok(!text.includes('"dependencies"'), `${p} отдал содержимое package.json`);
  }
});

test('страница отдаётся с указанием кодировки', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  const res = await fetch(`${s.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html; charset=utf-8/);
  const html = await res.text();
  assert.ok(html.includes('NOSTROMO GAMBIT'));
  assert.ok(html.includes('ОРБИТАЛЬНЫЙ ДЕСАНТ'), 'кириллица обязана дойти неискажённой');
});

test('идентификатор сессии виден и позволяет заметить перезапуск', async (t) => {
  const a = await startTestServer();
  const first = (await a.get('/health')).body.sessionId;
  await a.close();

  const b = await startTestServer();
  const second = (await b.get('/health')).body.sessionId;
  await b.close();

  assert.notEqual(first, second);
});

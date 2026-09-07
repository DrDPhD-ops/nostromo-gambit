// Один мультиплексированный поток событий.
//
// Почему ровно один: HTTP/1.1 держит около шести соединений на origin. Два потока
// (оценка и прогресс десанта) на двух вкладках — это уже четыре из шести, а третья
// вкладка вешает приложение целиком. Поэтому все типы событий идут по одному
// маршруту и различаются полем `event:`.
//
// Волатильные события (оценка, прогресс) намеренно идут БЕЗ поля `id:`: иначе они
// отравляют Last-Event-ID и при переподключении браузер просит воспроизвести
// с той точки, где нет ни одного состояния.

const RING_SIZE = 200;
const HEARTBEAT_MS = 15000;

export class SseHub {
  #clients = new Set();
  #ring = [];
  #timer = null;

  constructor({ sessionId }) {
    this.sessionId = sessionId;
  }

  get clientCount() {
    return this.#clients.size;
  }

  attach(req, res, { lastEventId = null, initial = null } = {}) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform обязателен: без него прокси и расширения вправе перепаковать
      // поток и склеить кадры.
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Подсказка обратным прокси не буферизовать поток.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    // Без этого Nagle склеивает шестидесятибайтные кадры оценки в рывки по 40 мс.
    res.socket?.setNoDelay?.(true);
    res.write(`retry: 3000\n\n`);

    const client = { res, alive: true };
    this.#clients.add(client);

    const replayed = lastEventId !== null ? this.#replayFrom(Number(lastEventId), client) : false;
    if (!replayed && initial) this.#writeTo(client, initial);

    req.on('close', () => {
      client.alive = false;
      this.#clients.delete(client);
    });

    if (!this.#timer) this.#startHeartbeat();
    return client;
  }

  #startHeartbeat() {
    this.#timer = setInterval(() => {
      for (const c of this.#clients) {
        try {
          c.res.write(': ping\n\n');
        } catch {
          this.#clients.delete(c);
        }
      }
    }, HEARTBEAT_MS);
    this.#timer.unref?.();
  }

  /** Кадр состояния: несёт id и попадает в кольцевой буфер. */
  emit(event, data, { id = null } = {}) {
    const frame = { event, data, id };
    if (id !== null) {
      this.#ring.push(frame);
      if (this.#ring.length > RING_SIZE) this.#ring.shift();
    }
    for (const client of [...this.#clients]) this.#writeTo(client, frame);
  }

  /** Кадр без id: оценка, прогресс, всё, что не является состоянием. */
  emitVolatile(event, data) {
    this.emit(event, data, { id: null });
  }

  #writeTo(client, frame) {
    if (!client.alive) return;
    try {
      let payload = '';
      if (frame.id !== null && frame.id !== undefined) payload += `id: ${frame.id}\n`;
      payload += `event: ${frame.event}\n`;
      // Многострочные данные обязаны разбиваться на несколько строк data:,
      // иначе перевод строки внутри полезной нагрузки рвёт кадр.
      const body = JSON.stringify(frame.data);
      for (const line of body.split('\n')) payload += `data: ${line}\n`;
      payload += '\n';
      client.res.write(payload);
    } catch {
      client.alive = false;
      this.#clients.delete(client);
    }
  }

  /** @returns {boolean} удалось ли воспроизвести хвост; false — нужен полный снимок. */
  #replayFrom(lastId, client) {
    if (!Number.isFinite(lastId)) return false;
    const idx = this.#ring.findIndex((f) => f.id > lastId);
    if (idx === -1) {
      // Либо клиент уже всё видел, либо ушёл слишком далеко — в обоих случаях
      // отдаём полный снимок, это дешевле и надёжнее любых догадок.
      return false;
    }
    if (this.#ring[0].id > lastId + 1) return false; // разрыв: часть событий уже вытеснена
    for (const frame of this.#ring.slice(idx)) this.#writeTo(client, frame);
    return true;
  }

  close() {
    if (this.#timer) clearInterval(this.#timer);
    for (const c of this.#clients) {
      try {
        c.res.end();
      } catch {
        /* соединение уже закрыто */
      }
    }
    this.#clients.clear();
  }
}

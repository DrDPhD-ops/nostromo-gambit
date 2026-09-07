// Детерминированный генератор. Не Math.random: и тесты, и ночной прогон обязаны
// воспроизводиться по сиду, иначе ни один упавший десант не удастся разобрать.
// xorshift128+ — быстрый, с приличным периодом и без внешних зависимостей.

function hashSeed(seed) {
  const s = String(seed);
  let h1 = 0x9e3779b9;
  let h2 = 0x85ebca6b;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761) >>> 0;
    h2 = Math.imul(h2 ^ ((c << 3) | (c >>> 5)), 1597334677) >>> 0;
  }
  // Нулевое состояние для xorshift — вырожденное, страхуемся.
  return [h1 || 0x1a2b3c4d, h2 || 0x5e6f7a8b, (h1 ^ h2) >>> 0 || 0xdeadbeef, (h1 + h2) >>> 0 || 0xfeedface];
}

export class Rng {
  constructor(seed = 'nostromo') {
    this.seed = String(seed);
    const [a, b, c, d] = hashSeed(seed);
    this.s = new Uint32Array([a, b, c, d]);
    // Прокручиваем, чтобы близкие сиды не давали похожих первых чисел.
    for (let i = 0; i < 20; i++) this.next();
  }

  /** Целое 32 бита. */
  next() {
    let t = this.s[3];
    const s0 = this.s[0];
    this.s[3] = this.s[2];
    this.s[2] = this.s[1];
    this.s[1] = s0;
    t ^= t << 11;
    t ^= t >>> 8;
    this.s[0] = (t ^ s0 ^ (s0 >>> 19)) >>> 0;
    return this.s[0];
  }

  /** [0, 1) */
  float() {
    return this.next() / 4294967296;
  }

  /** Целое из [min, max] включительно. */
  int(min, max) {
    if (max < min) return min;
    return min + (this.next() % (max - min + 1));
  }

  /** Один элемент массива. */
  pick(arr) {
    if (!arr || arr.length === 0) return undefined;
    return arr[this.next() % arr.length];
  }

  /** Перемешивание на месте (Фишер—Йетс). */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.next() % (i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** Выбор по весам: items — [{weight, ...}]. */
  weighted(items, weightOf = (x) => x.weight) {
    const total = items.reduce((s, x) => s + Math.max(0, weightOf(x)), 0);
    if (total <= 0) return this.pick(items);
    let roll = this.float() * total;
    for (const item of items) {
      roll -= Math.max(0, weightOf(item));
      if (roll <= 0) return item;
    }
    return items[items.length - 1];
  }

  /** Отдельный поток случайности, привязанный к метке — чтобы ветки не сдвигали друг друга. */
  fork(label) {
    return new Rng(`${this.seed}:${label}:${this.next()}`);
  }
}

export function makeRng(seed) {
  return new Rng(seed);
}

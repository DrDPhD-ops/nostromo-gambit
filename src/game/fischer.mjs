// Расстановка Фишера (шахматы 960).
//
// ВАЖНОЕ ОГРАНИЧЕНИЕ, о котором честно сказано и в интерфейсе:
// chess.js 1.4.0 принимает позицию Фишера, но НЕ умеет рокировку по правилам 960
// (проверено: в списке ходов нет ни одной записи O-O). Поэтому в этом режиме
// рокировка отключается — права рокировки выставляются в «-».
//
// Альтернативой было бы дописать генерацию 960-рокировки поверх chess.js, что
// означает вмешательство в её внутреннюю генерацию ходов. Для ночной сборки цена
// не оправдана, а молча выдавать «Фишера со сломанной рокировкой» нечестно.

const PIECES = ['r', 'n', 'b', 'q', 'k'];

/**
 * Случайная расстановка по правилам 960:
 *  - слоны на полях разного цвета;
 *  - король строго между ладьями.
 */
export function randomBackRank(rng) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const row = new Array(8).fill(null);
    const free = () => row.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);

    // Слоны: один на чётное поле, другой на нечётное.
    const light = [0, 2, 4, 6];
    const dark = [1, 3, 5, 7];
    row[light[rng.int(0, 3)]] = 'b';
    row[dark[rng.int(0, 3)]] = 'b';

    // Ферзь и кони — на любые оставшиеся.
    for (const piece of ['q', 'n', 'n']) {
      const spots = free();
      row[spots[rng.int(0, spots.length - 1)]] = piece;
    }

    // Оставшиеся три поля: ладья, король, ладья — король обязан быть посередине.
    const rest = free();
    if (rest.length !== 3) continue;
    row[rest[0]] = 'r';
    row[rest[1]] = 'k';
    row[rest[2]] = 'r';

    if (row.every(Boolean)) return row;
  }
  // Крайне маловероятно, но пусть будет: обычная расстановка.
  return ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
}

/** Полный FEN стартовой позиции Фишера. Рокировка выключена — см. шапку файла. */
export function fischerFen(rng) {
  const row = randomBackRank(rng);
  const black = row.join('');
  const white = row.join('').toUpperCase();
  return `${black}/pppppppp/8/8/8/8/PPPPPPPP/${white} w - - 0 1`;
}

/** Проверка правил расстановки — по ней написан тест. */
export function backRankIsValid(row) {
  if (row.length !== 8) return false;
  const count = (p) => row.filter((x) => x === p).length;
  if (count('k') !== 1 || count('q') !== 1 || count('r') !== 2 || count('b') !== 2 || count('n') !== 2) return false;

  const bishops = row.map((p, i) => (p === 'b' ? i : -1)).filter((i) => i >= 0);
  if (bishops.length !== 2 || bishops[0] % 2 === bishops[1] % 2) return false;

  const rooks = row.map((p, i) => (p === 'r' ? i : -1)).filter((i) => i >= 0);
  const king = row.indexOf('k');
  return rooks[0] < king && king < rooks[1];
}

export { PIECES };

// Кубики: 2d6 задают параметры десанта.
//
// Замысел в напряжении между двумя числами одного броска:
//   сумма    -> тоннаж (сколько материала прилетит обеим сторонам);
//   разброс  -> перекос (сколько сантипешек бросающий вправе забрать себе).
// Дубль даёт нулевой перекос, но чётную сумму; максимальный перекос (6-1) даёт
// всего 7 очков тоннажа. Выкрутить и объём, и наглость одновременно нельзя.

/** Жёсткий предел суммарного перекоса, включая собственный люфт планировщика. */
export const MAX_TOTAL_SKEW_CP = 120;

export const DICE = {
  budgetBase: 60,
  budgetStep: 90,
  skewStep: 20,
};

export function rollDice(rng) {
  return { d1: rng.int(1, 6), d2: rng.int(1, 6) };
}

/**
 * Разбор броска.
 * @param {{d1:number,d2:number}} dice
 * @param {'w'|'b'} side  кто бросил — в его пользу и уходит перекос
 */
export function interpretRoll({ d1, d2 }, side) {
  const sum = d1 + d2;
  const spread = Math.abs(d1 - d2);
  const budgetCp = DICE.budgetBase + DICE.budgetStep * (sum - 2);
  const magnitude = DICE.skewStep * spread;
  // Перекос всегда выражен в POV белых: белым в плюс, чёрным в минус.
  const skewCp = side === 'w' ? magnitude : -magnitude;
  return {
    d1,
    d2,
    sum,
    spread,
    budgetCp,
    skewCp,
    isDouble: spread === 0,
    side,
  };
}

/** Суммарная цель по перекосу с учётом люфта планировщика, с жёстким клампом. */
export function combineSkew(diceSkewCp, storytellerSkewCp) {
  const total = (diceSkewCp || 0) + (storytellerSkewCp || 0);
  return Math.max(-MAX_TOTAL_SKEW_CP, Math.min(MAX_TOTAL_SKEW_CP, total));
}

/** Строка-расшифровка для интерфейса — игрок должен понимать, что ему выпало. */
export function describeRoll(roll) {
  const dir = roll.skewCp === 0 ? '' : roll.side === 'w' ? ' В ПОЛЬЗУ МОРПЕХОВ' : ' В ПОЛЬЗУ КСЕНО';
  const skew = roll.skewCp === 0 ? 'РОВНО' : `${Math.abs(roll.skewCp)} СП${dir}`;
  return `СУММА ${roll.sum} → ТОННАЖ ${roll.budgetCp} СП · РАЗБРОС ${roll.spread} → ПЕРЕКОС ${skew}`;
}

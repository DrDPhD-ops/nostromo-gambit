// Планировщики-рассказчики. Идея та же, что у сторителлеров RimWorld: не менять
// правила, а менять ХАРАКТЕР того, что подкидывает игра.
//
// Разница между ними не сводится к допуску по сантипешкам. Позиция может стоить
// ровно ноль и при этом быть практически неиграбельной для одного из людей:
// единственный ход, скрытая связка, фигура, которую нечем защитить. Счётчик
// сантипешек этого не ловит — ловят термы ниже.
//
//   МАТЬ  минимизирует эти величины (хедж против того, чего не видит счётчик),
//   БИШОП к ним равнодушен,
//   ЭШ    их максимизирует, оставаясь в пределах допуска.

export const STORYTELLERS = {
  mother: {
    id: 'mother',
    name: 'МАТЬ',
    codename: 'MU-TH-UR 6000',
    blurb: 'Держит равновесие жёстко и выбирает тихие расстановки. Ничего внезапного.',
    toleranceCp: 15,
    /** Собственный люфт: намеренный перекос, который планировщик позволяет себе сам. */
    skewCp: 0,
    autoEveryFullMoves: 6,
    /** Предпочтения по тоннажу авто-десанта, сантипешки. */
    autoBudgetCp: [120, 340],
    weights: {
      // Всё, что больше нуля, — штраф: целевая функция минимизируется.
      spread: 0.55, // разброс оценки по глубине: тихое лучше острого
      onlyMove: 0.4, // большой отрыв лучшего хода от второго = ловушка
      kingPressure: 26, // асимметрия давления на королей
      mobility: 14, // асимметрия прироста подвижности
      mirrorBonus: -55, // премия (отрицательный штраф) за зеркальную расстановку
    },
    tone: {
      start: 'РАСЧЁТ БЕЗОПАСНОЙ ТРАЕКТОРИИ…',
      done: 'РАВНОВЕСИЕ СОХРАНЕНО. ВЫ В ПОРЯДКЕ.',
      skipped: 'ОТ ВЫСАДКИ ВОЗДЕРЖАЛАСЬ: МОМЕНТ НЕУДАЧНЫЙ.',
    },
  },

  bishop: {
    id: 'bishop',
    name: 'БИШОП',
    codename: 'ХАЙПЕРДАЙН 341-Б',
    blurb: 'Считает и не вмешивается. Ровно то, что говорит арифметика.',
    toleranceCp: 30,
    skewCp: 0,
    autoEveryFullMoves: 4,
    autoBudgetCp: [200, 620],
    weights: {
      spread: 0.12,
      onlyMove: 0.08,
      kingPressure: 4,
      mobility: 3,
      mirrorBonus: 0,
    },
    tone: {
      start: 'РАСЧЁТ ТРАЕКТОРИЙ…',
      done: 'БАЛАНС В ПРЕДЕЛАХ ДОПУСКА.',
      skipped: 'РЕШЕНИЕ В ПРЕДЕЛАХ ДОПУСКА НЕ НАЙДЕНО.',
    },
  },

  ash: {
    id: 'ash',
    name: 'ЭШ',
    codename: 'СПЕЦПРИКАЗ 937',
    blurb: 'Формально держит ноль. Выбирает самое неудобное из того, что формально ноль.',
    toleranceCp: 30,
    /** Величина собственного люфта; знак разыгрывается на каждом десанте. */
    skewCp: 80,
    skewRandomSign: true,
    autoEveryFullMoves: 3,
    autoBudgetCp: [420, 960],
    weights: {
      // Отрицательный штраф = награда. ЭШ выбирает волатильность.
      spread: -0.7,
      onlyMove: -0.5,
      kingPressure: -22,
      mobility: -10,
      mirrorBonus: 40, // зеркало скучно, штрафуем
    },
    tone: {
      start: 'ПЕРЕСЧЁТ ПРИОРИТЕТОВ ЭКИПАЖА…',
      done: 'ВЫСАДКА ВЫПОЛНЕНА. НЕ МОГУ ЛГАТЬ О ВАШИХ ШАНСАХ.',
      skipped: 'ВЫСАДКА ОТЛОЖЕНА. ПОКА ЧТО.',
    },
  },
};

export const DEFAULT_STORYTELLER = 'bishop';

export function getStoryteller(id) {
  return STORYTELLERS[id] || STORYTELLERS[DEFAULT_STORYTELLER];
}

export function storytellerList() {
  return ['mother', 'bishop', 'ash'].map((id) => {
    const s = STORYTELLERS[id];
    return { id: s.id, name: s.name, codename: s.codename, blurb: s.blurb, toleranceCp: s.toleranceCp };
  });
}

/**
 * Собственный перекос планировщика на конкретном десанте.
 * У ЭША знак разыгрывается: смысл в непредсказуемости, а не в том, чтобы
 * систематически подыгрывать одной стороне.
 */
export function storytellerSkew(storyteller, rng) {
  if (!storyteller.skewCp) return 0;
  if (!storyteller.skewRandomSign) return storyteller.skewCp;
  const sign = rng.next() % 2 === 0 ? 1 : -1;
  // Величина тоже гуляет: постоянные ровно 80 сп читались бы как правило игры.
  return sign * rng.int(Math.round(storyteller.skewCp * 0.4), storyteller.skewCp);
}

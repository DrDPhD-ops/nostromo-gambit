export const meta = {
  name: 'knights-and-liars-lore',
  description: 'Lore, tone and admiral super-weapons for the multiverse battleship game: Warhammer x Lovecraft with adventure-comedy flair',
  phases: [
    { title: 'Лор', detail: '4 independent lore/tone/arsenal proposals' },
    { title: 'Критика', detail: 'two lenses: does it land, does it become mechanics' },
    { title: 'Свод', detail: 'one lore bible + arsenal spec + all Russian in-game text' },
    { title: 'Проверка', detail: 'tone consistency and legal/IP safety pass' },
  ],
}

const SEED = `
=== THE GAME (already being designed in parallel) ===
An 8-bit game for a Russian-speaking user. Core mechanic, from his own brainstorm:

Battleship where the DEFENDER may rearrange their fleet arbitrarily between shots, as long as every answer already given (hit / kill / miss) remains true of the new arrangement. A machine can do that combinatorics trivially; a human cannot — so the game does it for the human. Every rearrangement is a road into the multiverse: the fleet is not hidden, it is genuinely UNDETERMINED, and it collapses only where you have pinned it down.

Fictional justification already agreed in the brainstorm:
- An ALCUBIERRE DRIVE that cannot move you in time (no past, no future) but CAN carry you across the BRANE into an adjacent version of reality where the ships stood differently.
- A Lovecraftian unknowable dark god that "twists reality wherever you have not pinned it down" ("Непознанный тёмный бог искажает реальность там, где ты её не пришпилил"). This is the fictional statement of the mechanic: unobserved = unfixed = hostile.
- The Warhammer 40k GELLER FIELD: a bubble of stable reality inside the immaterium, where the laws of physical spacetime still hold instead of the warp's perverted rules. Obvious mechanic: project it on a region and reality inside is PINNED and can no longer shift.
- A Doctor Strange joke about watching 14,000,605 futures — so the HUD's centrepiece is a counter of remaining consistent realities, ticking down from millions to 1.
- "Но каждый мой выстрел накрывает корабли сразу во всех ветках!" — a shot lands in ALL branches at once.

=== NEW DIRECTION FROM THE USER, VERBATIM AND BINDING ===
1. "не надо ее гамбитом называть, более креативно как то блин"
   => The existing companion game is called 'Nostromo Gambit'. The new game must NOT be called "<something> Gambit". Find something more creative.
2. "Хотя бы Рыцари и лжецы в мультивселенной безумия"
   => He is at minimum happy with "Рыцари и лжецы в мультивселенной безумия" (Knights and Liars in the Multiverse of Madness). NOTE THE DEEP RESONANCE: "рыцари и лжецы" is the classic logic puzzle where a KNIGHT can never lie and a LIAR always lies. This game's enemy is formally a knight — every hit/kill/miss it reports is literally true — yet it behaves like a liar. The title is a thesis about the mechanic, not decoration. Beat that title or build on it.
3. "короче нужно подумать над лором, что то типа Вархаммер и одновременно Лавкрафт"
   => The lore must be Warhammer AND Lovecraft at once. Gothic militarised far-future grimdark plus unknowable cosmic horror.
4. "там нужно придумать какие то суперштуки для адмиралов космических флотов которые сражаются, типа одной торпедой накрыть сразу несколько секторов пространства времени (ну т е клетку во всех мультивселенных сразу) — гиперпространственная бранпеда — или вернуть фокус в нужную тебе брану"
   => He wants SUPER-WEAPONS for the duelling space admirals. Two he named himself:
      * "ГИПЕРПРОСТРАНСТВЕННАЯ БРАНПЕДА" — a brane-torpedo (a portmanteau of брана + торпеда) that covers one cell across several sectors of spacetime at once, i.e. the same cell in many universes simultaneously. THIS WORD IS A GIFT — it must be in the game, spelled exactly "бранпеда".
      * "вернуть фокус в нужную тебе брану" — refocus reality into the brane YOU want. A steering-of-reality weapon.
   => Invent more in the same spirit.
5. "короче добавь еще какого авантюристического флера. Типа Ларри или Автостопом по галактике"
   => ADVENTUROUS FLAIR, in the register of Leisure Suit Larry or The Hitchhiker's Guide to the Galaxy. Irreverent, absurd, comic, adventurous — a scoundrel's voice. Douglas Adams' deadpan bureaucratic absurdism is the closest single reference.

=== THE HARD TONAL PROBLEM ===
Grimdark Warhammer + cosmic-horror Lovecraft + Hitchhiker's-Guide comedy is a genuinely difficult cocktail. Done badly it is a Reddit-tier parody that is neither funny nor frightening. Done well it is the best thing in the project: the horror stays real, and the JOKE is the tiny human trying to file the correct paperwork about it. The comedy must come from the PROTAGONIST'S VOICE and the absurd bureaucracy of an institution that has industrialised the unspeakable — never from mocking the horror itself. Solving this cocktail precisely is the main job here.

=== HOUSE STYLE (the companion project, 'nostromo-gambit') ===
- ALL in-game text is in RUSSIAN. Interface text is ALL-CAPS with wide letter-spacing; body copy is normal sentence case.
- The aesthetic is a green-phosphor / amber CRT ship terminal, scanlines, boot typewriter. The player is reading a MILITARY COMPUTER TERMINAL, so text should read as machine output, log lines, telemetry, terse briefings.
- Voice in the existing game: dry, technical, understated, competent. Example UI strings: "ТРЮМ ПОЛОН — ДЕСАНТ ПОСЛЕ ПЕРВЫХ ПОТЕРЬ", "СОСТОЯНИЕ УСТАРЕЛО", "ОТКАЗАНО", "ВЫЧИСЛИТЕЛЬНЫЙ КОМПЛЕКС · ИНИЦИАЛИЗАЦИЯ", "СВЯЗЬ С АРБИТРОМ БАЛАНСА ............. УСТАНОВЛЕНА", "ГОТОВ К ПРИЁМУ ПАРАМЕТРОВ ОПЕРАЦИИ".
- The new game keeps that terminal frame but adds the adventurous, comic register on top. Figure out exactly WHERE the comedy is allowed to live so the terminal stays credible: e.g. the machine stays deadpan and correct, while the JOKE is what it is deadpan ABOUT.
- Docs (README) are in Russian too, with a dry technical voice.
- Legal caution the project already observes: it writes its own names and texts, does not reproduce third-party trademarks, logos or copyrighted text; it is an HOMAGE, never a copy. 'Warhammer 40,000', 'Geller field', 'Imperium', 'Cthulhu' etc. are other people's trademarks and creations. So: invent our OWN names that evoke them. The Geller field in particular needs our own name.
`

phase('Лор')

const ANGLES = [
  {
    key: 'мифология',
    prompt: `You are the WORLD-BUILDER. Your job is the spine of the fiction: Warhammer-grade gothic militarised far-future PLUS Lovecraftian cosmic horror, welded into one setting that makes the game's mechanic inevitable.

Answer concretely and commit:
- What is the setting called? What is the human institution the player serves — its name, its ideology, its absurd bureaucracy? (Ours, not anyone else's trademark.)
- WHO IS THE PLAYER? An admiral, and what kind: a decorated hero, a disgraced one, a fraud with a stolen commission (that last one would fund the Larry/Adams register nicely)? Give them a name, a rank, a reason to be out here.
- WHY DOES A FLEET EXIST IN SUPERPOSITION? Give the in-fiction physics of the brane-crossing drive, in the confident nonsense register of good science fiction. It must feel like a real doctrine with real costs, not a hand-wave.
- THE ENEMY. Warhammer says a gothic xeno/heretic armada; Lovecraft says an unknowable god. Reconcile them: is the enemy fleet the god's limbs? Is the enemy admiral a person at all? The brainstorm's line was "an unknown dark god twists reality wherever you have not pinned it down" — build the antagonist from that sentence. Name it (or explain why it cannot be named, and what people call it instead).
- THE KNIGHTS-AND-LIARS THESIS. Make the logic puzzle diegetic: WHY is the enemy incapable of lying outright, yet free to reshape everything it has not been forced to confirm? A compact, chilling in-fiction law — "the Covenant of the Answered Question" or similar — that a player will quote. This is the most important paragraph you will write.
- OUR OWN NAME for the stable-reality bubble (the thing Warhammer calls a Geller field). Several candidates, in Russian, with the winner argued.
- The cost of using the multiverse: what does it do to a crew, a mind, a career? Give the corruption/madness track its fiction.
- Act structure: 3-5 escalating opponents/admirals, each with a name, a doctrine, a personality and a reason the difficulty rises.

Write in Russian where you are naming things or writing in-world text; the analysis around it can be Russian too. Be specific, be strange, be confident.`,
  },
  {
    key: 'голос',
    prompt: `You are the COMEDY / VOICE director. Your single job is to solve the tonal cocktail: grimdark Warhammer + Lovecraft + the adventurous comic register of The Hitchhiker's Guide to the Galaxy and Leisure Suit Larry, on a green-phosphor military terminal, in Russian.

Deliver:
- THE TONAL RECIPE, stated as rules a writer can follow: exactly where comedy is allowed and where it is forbidden. My working hypothesis, which you should sharpen or replace: the machine stays perfectly deadpan and technically correct, and the comedy comes from WHAT it is deadpan about — a form to be filled in before reality is allowed to collapse, a warranty voided by observing the enemy, a mandatory safety notice about the void. The horror is never the punchline; the INSTITUTION is.
- The narrator/companion: does the ship have an onboard machine intelligence with a personality? (An Adams-grade one — over-helpful, bureaucratic, mildly suicidal, or aggressively cheerful — is the single cheapest way to carry both the comedy AND the tutorial.) Name it, define it in 5 lines, and write 20 of its actual lines in Russian.
- 30 ENEMY BARKS in Russian: what the enemy says when it answers a shot. Remember it is TECHNICALLY TRUTHFUL AND INFINITELY EVASIVE — smug, alien, pedantic, correct. Vary them for МИМО / ПОПАЛ / УБИТ / and for the moment the player forces a big collapse.
- 15 lines of the ship's terminal boot sequence in Russian, in the house style (ALL-CAPS, dotted leaders, deadpan), where the humour is in the content and never in the formatting.
- The opening briefing (the real text, Russian, 120-200 words) that teaches the mechanic through voice: you are shooting at a fleet that has not decided where it is.
- Victory text, defeat text, and the text for the worst outcome (the player leaning on the multiverse so hard that the god notices them).
- 10 loading/interstitial one-liners.
- ANTI-EXAMPLES: 5 lines that would be WRONG for this game, each with one sentence on why. This calibrates everyone else.

All in-game text must be in Russian and must be the real final text, not a description of it.`,
  },
  {
    key: 'арсенал',
    prompt: `You are the ARSENAL designer. The user asked, verbatim, for "суперштуки для адмиралов космических флотов" — super-things for the duelling space admirals — and named two himself: the ГИПЕРПРОСТРАНСТВЕННАЯ БРАНПЕДА (a brane-torpedo covering one cell across several universes at once) and something that "returns the focus into the brane you want".

Design the full arsenal. Every entry MUST have all of:
  (a) a great Russian name, in the бранпеда register — portmanteaus, mock-official designations, absurd model numbers ("БРАНПЕДА ТИП-7 «ОТВЕТ»");
  (b) one line of in-world flavour;
  (c) a PRECISE MECHANIC in terms of the underlying maths — the enemy fleet is a SET of fleet placements consistent with every answer given so far, and every weapon must be an operation on that set: constrain it, split it, force a commitment, freeze a region, sample from it, or reveal an aggregate over it;
  (d) a cost, a cooldown or a charge count, and the resource it spends;
  (e) the counterplay or the drawback — ideally, feeding the dark god;
  (f) how it READS on screen in 8-bit: one sentence of visual.

Cover at minimum:
- БРАНПЕДА: the same cell fired at across k branches at once. Work out what that actually MEANS on the set of consistent placements — the honest reading is "the defender may not use its freedom to dodge this cell: it must answer as if committed", or "it hits every configuration where that cell is occupied, killing that whole family of realities". Pick the reading that is both faithful to the user's words and a real, powerful, teachable rule.
- REFOCUSING INTO A CHOSEN BRANE: the player picks which surviving reality becomes the real one, subject to constraints. What limits it so it is not simply "I win"?
- The stable-reality bubble (our own name for a Geller field): pin a region so it can no longer shift.
- A SALVO: k cells fired simultaneously so the enemy must answer all k with ONE single configuration. (Against an adaptive defender this is strictly stronger than k sequential shots — a real, teachable skill lever.)
- A PROBE / AUGURY that reveals an aggregate rather than a cell (e.g. "how many hull cells lie inside this region"), collapsing enormous numbers of realities at once.
- Something DEFENSIVE for the player's own superposed fleet.
- Something that is a TRAP or a gamble — high risk, feeds the god, occasionally catastrophic. The Larry/Adams register lives here.
- At least three more of your own invention that only make sense in this game.

Then: an ECONOMY. What is the resource called, how is it earned, what are the prices, and what is the interesting decision each turn? Give a table. Then name the three most common opening turns a good player would take, to prove the economy has depth.`,
  },
  {
    key: 'название',
    prompt: `You are the NAMING lead. Deliverables, all in Russian unless a Latin title genuinely wins.

1. THE TITLE. Hard constraint: it must NOT be "<something> Gambit" — the user explicitly rejected that ("не надо ее гамбитом называть, более креативно как то блин"). His own fallback, which he says he is at least happy with, is «РЫЦАРИ И ЛЖЕЦЫ В МУЛЬТИВСЕЛЕННОЙ БЕЗУМИЯ». Your job is to either beat it or to prove it is the winner and refine it (e.g. a punchier main title with that as the subtitle).
   Generate at least 25 candidates across distinct strategies: the logic-puzzle angle (knights and liars, the truthful monster), the physics angle (branes, superposition, collapse, the unpinned), the grimdark-institutional angle (mock-official designations, protocol numbers, the name of a doctrine), the Adams angle (absurdly long or absurdly bland titles that are funny precisely because they are bureaucratic), and the pure-cool angle. Then shortlist 5, argue them, and COMMIT to one, with the subtitle, and with the folder name in Latin kebab-case for the filesystem. State plainly why the winner beats «Рыцари и лжецы».
   The game sits next to a project called 'nostromo-gambit', so a name that quietly rhymes with it as a sibling work is a bonus, never a requirement.
2. The name of the in-world doctrine / law that forbids the enemy from lying (the knights-and-liars covenant).
3. Names for: the enemy fleet, the dark god (or the euphemism people use instead), the player's ship, the player's institution, the ship's machine intelligence, the resource currency, the reality counter as it is labelled on the HUD, the difficulty levels (5 of them, in the style of the companion game's "1 РЯДОВОЙ … 5 MU-TH-UR 6000"), and the 3-5 enemy admirals with their doctrines.
4. The single line that goes under the title on the start screen (the companion game uses "ШАХМАТЫ С ОРБИТАЛЬНЫМ ДЕСАНТОМ · ТАКТИЧЕСКИЙ МОДУЛЬ"). Write ours.
5. A favicon concept describable as a handful of coloured rectangles, matching the companion game's inline-SVG favicon approach.
6. TRADEMARK SAFETY: flag any candidate name that is too close to an existing franchise's property and replace it. We want homage, never appropriation.`,
  },
]

const proposals = await parallel(ANGLES.map((a) => () =>
  agent(`${SEED}\n\n${a.prompt}`, { label: `лор:${a.key}`, phase: 'Лор', agentType: 'Plan', effort: 'high' })
    .then(text => ({ key: a.key, text }))
))

const good = proposals.filter(Boolean)

phase('Критика')

const CRIT_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number' },
    lands: { type: 'number', description: '0-100: does the tone actually work — funny where it means to be, frightening where it means to be' },
    mechanical: { type: 'number', description: '0-100: does this turn into real, implementable rules rather than flavour text' },
    kill: { type: 'string', description: 'what must be cut: the cringe, the try-hard, the joke that dies on the second reading, the ability that is just another ability' },
    keep: { type: 'string', description: 'the specific lines, names and rules that MUST survive, quoted exactly' },
    fixes: { type: 'string' },
  },
  required: ['score', 'lands', 'mechanical', 'kill', 'keep', 'fixes'],
}

const LENSES = [
  { key: 'вкус', q: `THE TASTE LENS. You are a merciless Russian-speaking editor with perfect ear for tone. Warhammer-plus-Lovecraft-plus-Hitchhiker's is one step from cringe. Find every line that is trying too hard, every joke that dies on second reading, every piece of edgy grimdark boilerplate, every Anglicism that reads badly in Russian. Quote the offenders. Then say which lines are genuinely good and why. Judge the RUSSIAN as Russian — rhythm, register, whether a real person would find it funny or wince.` },
  { key: 'механика', q: `THE MECHANICS LENS. You are the designer who has to turn this fiction into rules. The enemy fleet is a SET of placements consistent with all answers given; every ability must be a concrete operation on that set. Go ability by ability: is it implementable, is it distinct from the others, is it balanced, is it teachable in one sentence, does it survive contact with a player who optimises? Kill every ability that is a reskin of another. Flag any fiction that promises something the maths cannot deliver.` },
]

const critiques = await pipeline(
  good,
  (p) => parallel(LENSES.map(l => () =>
    agent(`${SEED}\n\nHere is a proposal (angle: ${p.key}):\n<<<\n${p.text}\n>>>\n\n${l.q}\n\nScore and report.`,
      { label: `критика:${p.key}:${l.key}`, phase: 'Критика', agentType: 'Plan', schema: CRIT_SCHEMA })
  )).then(vs => ({ key: p.key, text: p.text, reviews: vs.filter(Boolean) }))
)

const reviewed = critiques.filter(Boolean)
for (const r of reviewed) {
  const avg = r.reviews.length ? Math.round(r.reviews.reduce((s, v) => s + v.score, 0) / r.reviews.length) : 0
  log(`${r.key}: ${avg} (тон ${r.reviews.map(v => v.lands).join('/')}, механика ${r.reviews.map(v => v.mechanical).join('/')})`)
}

phase('Свод')

const bundle = reviewed.map(r => `
######## ПРЕДЛОЖЕНИЕ: ${r.key} ########
${r.text}

---- КРИТИКА '${r.key}' ----
${r.reviews.map(v => `[${v.score} | тон ${v.lands} | механика ${v.mechanical}]
УБРАТЬ: ${v.kill}
СОХРАНИТЬ: ${v.keep}
ПРАВКИ: ${v.fixes}`).join('\n\n')}
`).join('\n\n')

const BIBLE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'final title in Russian, plus subtitle, plus the Latin kebab-case folder name, plus one paragraph arguing why it beats «Рыцари и лжецы в мультивселенной безумия» — or why that IS the winner' },
    premise: { type: 'string', description: 'the setting, the institution, the player character, the enemy, the dark god, and the in-fiction physics of brane-crossing. Russian.' },
    covenant: { type: 'string', description: 'the knights-and-liars law: the named in-world doctrine that forbids the enemy from lying yet frees it to reshape everything unconfirmed. Include the quotable formulation.' },
    tone_rules: { type: 'string', description: 'the tonal recipe as enforceable rules: where comedy lives, where it is forbidden, with 3 good examples and 3 anti-examples' },
    arsenal: { type: 'string', description: 'every weapon and ability: Russian name, flavour line, exact operation on the set of consistent fleet placements, cost, cooldown, drawback, and its 8-bit visual. Must include БРАНПЕДА and the refocus-your-brane ability. Table form where possible.' },
    economy: { type: 'string', description: 'the resource, its Russian name, how it is earned, the price list, and the interesting decision each turn' },
    admirals: { type: 'string', description: 'the 3-5 enemy admirals: name, doctrine, personality, the visible tell a player can learn to read, and the counter-strategy' },
    ai_companion: { type: 'string', description: 'the ship intelligence: name, 5-line character definition, and 20 of its actual lines in Russian' },
    text_ui: { type: 'string', description: 'ALL interface strings in Russian, ALL-CAPS house style: buttons, statuses, errors, labels, the HUD reality counter label, tooltips' },
    text_story: { type: 'string', description: 'ALL narrative text in Russian, final and ready to paste: boot sequence, opening briefing, act interstitials, victory, defeat, the god-notices-you ending, 10 interstitial one-liners' },
    text_barks: { type: 'string', description: '30+ enemy barks in Russian for МИМО / ПОПАЛ / УБИТ / big collapse, in the voice of something technically truthful and infinitely evasive' },
    naming: { type: 'string', description: 'the complete name registry: fleet, god, ship, institution, currency, 5 difficulty levels, the stable-reality bubble (our own name, not a trademark), the HUD counter' },
    ip_safety: { type: 'string', description: 'confirmation that every name is ours, listing anything renamed to avoid a third-party trademark, and the homage disclaimer line for the README' },
  },
  required: ['title', 'premise', 'covenant', 'tone_rules', 'arsenal', 'economy', 'admirals', 'ai_companion', 'text_ui', 'text_story', 'text_barks', 'naming', 'ip_safety'],
}

const bible = await agent(
  `${SEED}\n\nFour writers worked this in parallel and each proposal was torn apart by a taste lens and a mechanics lens. Everything:\n\n${bundle}\n\nYou are the LEAD WRITER. Produce ONE final lore bible.

Rules:
- Choose the strongest spine, then graft in every line the critics marked as 'must survive'. Do not average — choose, then improve. Quote the good lines verbatim into your output; they are the deliverable.
- Every line the taste critic called cringe is dead. Do not rescue it.
- Every ability the mechanics critic called unimplementable or a reskin is either fixed into a distinct, precise operation on the set of consistent fleet placements, or cut.
- «БРАНПЕДА» is mandatory and must be spelled exactly that way; so is an ability for returning the focus into a chosen brane. Both are the user's own words.
- ALL in-game text is FINAL RUSSIAN TEXT, ready to paste into source files. Not descriptions of text. Interface strings ALL-CAPS in the house style; narration in sentence case.
- Names must be ours. Homage, never appropriation. No third-party trademarks as our own labels.
- The tone must survive a second reading: funny in the register of Douglas Adams, frightening in the register of Lovecraft, and institutional in the register of grimdark far-future war — with the machine terminal always deadpan.

This goes straight into a plan file and then into source.`,
  { label: 'свод:лор-библия', phase: 'Свод', agentType: 'Plan', effort: 'high', schema: BIBLE_SCHEMA }
)

phase('Проверка')

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', description: 'ГОДНО or ПЕРЕДЕЛАТЬ' },
    problems: { type: 'string', description: 'concrete problems with the specific fix for each' },
    rewrites: { type: 'string', description: 'specific lines rewritten better, given as before -> after' },
  },
  required: ['verdict', 'problems', 'rewrites'],
}

const B = `
НАЗВАНИЕ: ${bible?.title}
ПОСЫЛКА: ${bible?.premise}
ЗАВЕТ: ${bible?.covenant}
ТОН: ${bible?.tone_rules}
АРСЕНАЛ: ${bible?.arsenal}
ЭКОНОМИКА: ${bible?.economy}
АДМИРАЛЫ: ${bible?.admirals}
ИИ: ${bible?.ai_companion}
ИНТЕРФЕЙС: ${bible?.text_ui}
СЮЖЕТ: ${bible?.text_story}
РЕПЛИКИ: ${bible?.text_barks}
ИМЕНА: ${bible?.naming}
ПРАВА: ${bible?.ip_safety}
`

const checks = await parallel([
  () => agent(`${SEED}\n\nИтоговая библия:\n${B}\n\nВы — РЕДАКТОР РУССКОГО ТЕКСТА и одновременно самый придирчивый читатель. Прочитайте весь игровой текст вслух в голове. Найдите: кальки с английского, неестественный порядок слов, шутки, которые не смешны на второй раз, пафос, который проваливается, канцелярит там, где он не является шуткой, и наоборот — места, где канцелярит работает и его надо усилить. Проверьте, что регистр выдержан: терминал сухой, ИИ — смешной, враг — жуткий и педантичный. Перепишите конкретные строки в формате «было -> стало». Не пересказывайте, а правьте.`,
    { label: 'проверка:русский-текст', phase: 'Проверка', agentType: 'Plan', effort: 'high', schema: CHECK_SCHEMA }),

  () => agent(`${SEED}\n\nИтоговая библия:\n${B}\n\nYou are the IP-SAFETY and ORIGINALITY reviewer. This is an homage project that must not appropriate anyone's property. Go through every proper noun, every ability name, every institution and every piece of quoted in-world text. Flag anything that is (a) a registered trademark or a distinctive protected term of an existing franchise used as our own label, (b) a near-identical copy of a distinctive name, or (c) verbatim text from an existing work. For each, propose our own replacement that keeps the flavour. Explicitly check the Warhammer 40k terms (Geller field, immaterium, warp, Imperium, inquisition, astropath, and the like), the Lovecraft mythos proper nouns, Dune, Alien, Doctor Strange and Hitchhiker's Guide. Generic physics vocabulary (brane, Alcubierre, superposition, decoherence) is free and should be used freely. Also confirm the game does not merely retell someone's plot.`,
    { label: 'проверка:права', phase: 'Проверка', agentType: 'Plan', effort: 'high', schema: CHECK_SCHEMA }),
])

const v = checks.filter(Boolean)
return { bible, editor: v[0], ip: v[1], scores: reviewed.map(r => ({ angle: r.key, avg: r.reviews.length ? Math.round(r.reviews.reduce((s, x) => s + x.score, 0) / r.reviews.length) : 0 })) }

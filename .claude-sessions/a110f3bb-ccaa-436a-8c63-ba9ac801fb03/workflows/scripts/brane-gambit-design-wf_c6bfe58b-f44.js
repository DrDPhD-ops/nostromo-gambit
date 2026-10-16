export const meta = {
  name: 'brane-gambit-design',
  description: 'Design a new 8-bit adversarial-multiverse Battleship game matching Nostromo Gambit quality',
  phases: [
    { title: 'Recon', detail: 'study nostromo-gambit as the tech + quality reference' },
    { title: 'Design', detail: '4 independent design proposals from different angles' },
    { title: 'Critique', detail: 'adversarial review of each proposal, 2 lenses each' },
    { title: 'Algorithm', detail: 'nail the adversarial-defender solver + perf budget' },
    { title: 'Synthesize', detail: 'merge into one buildable spec' },
    { title: 'Verify', detail: 'feasibility + completeness pass' },
  ],
}

const CONCEPT = `
THE SEED IDEA (from a Telegram brainstorm between the user, Alexander Didenko, and a friend — original Russian, translated):

- "Морской бой, в котором ты имеешь право переставлять корабли как угодно, если данные, которые ты сообщил при выстрелах врага остаются верными (попал, убил, мимо). И ты можешь это делать перед каждым выстрелом врага."
  => Battleship where the DEFENDER may rearrange their fleet arbitrarily between enemy shots, as long as every answer already given (hit / kill / miss) remains true of the new arrangement. Allowed before every enemy shot.
- "Понятно, что машина это легко сделает. Но вот человеку такая комбинаторика может быть сложна."
  => A machine can do this combinatorics trivially; a human cannot. (=> the game must do the combinatorics FOR the human player, and make it legible.)
- "это тоже будет восьмибитная игра" => it must be an 8-bit game.
- "тут идея в множественности реальностей" => the theme is multiplicity of realities.
- "у тебя есть двигатель Алькубьерре. Он не позволяет уйти ни в будущее ни в прошлое, но он позволяет по бране перейти в соседнюю версию реальности где космические корабли по другому стояли."
  => An Alcubierre drive: no time travel, but you can cross the BRANE into a neighbouring version of reality where the ships stood differently. (This is the in-fiction justification for rearranging.)
- "Лавкрафтовскую историю надо брать. Непознанный темный бог искажает реальность там, где ты ее не пришпилил."
  => Lovecraftian framing: an unknowable dark god twists reality wherever you have NOT pinned it down. (This is the perfect fictional statement of the core mechanic: unobserved = unfixed = hostile.)
- "Либо это битва с доктором Стрэнжем, который смотрит 14млн вариантов сценариев и выбирает нужный" (+ a Doctor Strange gif)
  => The 14,000,605 futures reference. Suggests a visible COUNTER of remaining consistent realities.
- "Смотри, каждая твоя перестановка открывает дорогу в мультивселенную" / "Но каждый мой выстрел накрывает корабли сразу во всех ветках!"
  => Every rearrangement opens a road into the multiverse; a shot lands in ALL branches at once.
- "есть особый снаряд которым я могу накрыть сразу несколько альтернативных веток"
  => a special munition that covers several alternative branches at once.
- Warhammer 40k GELLER FIELD was raised: "Генераторы поля создают вокруг корабля почти невидимую энергетическую завесу — своеобразный пузырь реальности. Внутри этого пузыря продолжают действовать законы физического пространства-времени, а не хаотичные и извращённые правила Имматериума."
  => A bubble of STABLE reality. Obvious mechanic: project it onto a region and reality inside is PINNED — cannot shift any more. Literally "пришпилить реальность".
- Working title floated by the friend: "Рыцари и лжецы в мультивселенной безумия" (Knights and Liars in the Multiverse of Madness).
- The user's verdict on the state of the idea: "короче надо докрутить" (needs finishing/tightening).

WHAT THE USER ASKED FOR NOW (verbatim):
"Мне нужна новая 8битная игра. Я вообще без понятия как ты ее сделаешь и в каком лоре. Но она должна быть такая же крутая как десант Nostromo."
=> A new 8-bit game, lore is my call, it must be as cool as the Nostromo landing game (the existing project 'nostromo-gambit'). The user then said: work maximally autonomously, they are going to sleep. So: NO questions can be asked. Make confident decisions and justify them.

MY WORKING DIRECTION (challenge it if it is wrong, but this is the frame):
The player is the ATTACKER hunting a fleet that exists in superposition. The enemy fleet is not "hidden" — it is genuinely UNDETERMINED, collapsing only where the player has pinned it. The HUD's centrepiece is a big counter of remaining consistent realities, ticking down from millions. The visual signature is GHOST FLEETS: faint flickering silhouettes of sampled possible placements drawn over the enemy grid, converging into solid hulls as the possibility space collapses. Symmetrically, the PLAYER's own fleet also evades — the machine does that combinatorics for the human — but evading costs a resource and feeds the dark god.

CONSTRAINT: the deliverable must be a finished, polished, self-contained 8-bit game of the same production quality and scale as the existing 'nostromo-gambit' project. Not a prototype, not a toy. It must be genuinely fun to a human, not just conceptually clever.
`

const REF_NOTE = `
THE REFERENCE PROJECT: the user's working directory is 'G:\\Другие компьютеры\\PAULEKMAN\\dev' (a Windows / Google-Drive-synced folder). Inside it is a folder named 'nostromo-gambit' — an 8-bit game I (Claude) already built for this same user, and the explicit quality bar for the new game ("такая же крутая как десант Nostromo"). Locate it with Glob (try 'nostromo-gambit/**') and READ IT before designing anything.
`

phase('Recon')
const RECON_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'exact folder path of nostromo-gambit' },
    stack: { type: 'string', description: 'tech stack: single-file HTML? canvas? react? build tooling? deps?' },
    files: { type: 'string', description: 'file listing with sizes/line counts' },
    total_lines: { type: 'number', description: 'total lines of game code, the scale bar to match' },
    aesthetic: { type: 'string', description: 'exactly how the 8-bit look is achieved: fonts, palette hex values, canvas resolution and scaling, sprite technique, CRT/scanline effects' },
    audio: { type: 'string', description: 'audio engine: webaudio chiptune? function signatures? verbatim key snippets' },
    architecture: { type: 'string', description: 'game loop, state machine, screens, input handling, save/persistence' },
    reusable: { type: 'string', description: 'reusable helpers worth copying: text rendering, dialogue boxes, particles, screen shake, transitions — with verbatim signatures' },
    ui_language: { type: 'string', description: 'is the in-game text Russian or English? quote examples' },
    tone: { type: 'string', description: 'the writing voice, difficulty, pacing, how it opens and ends, what makes it feel good' },
    how_to_run: { type: 'string', description: 'how it is launched/tested; any deployment (artifact URL, itch, pages)' },
    verbatim_snippets: { type: 'string', description: 'the most important code verbatim: palette, audio engine, render helpers, main loop skeleton' },
  },
  required: ['path', 'stack', 'total_lines', 'aesthetic', 'audio', 'architecture', 'ui_language', 'tone', 'how_to_run', 'verbatim_snippets'],
}

const recon = await agent(
  `${REF_NOTE}

Study the 'nostromo-gambit' project exhaustively and report a technical + aesthetic brief. Read the ACTUAL source, do not guess. I am about to build a second game for the same user that must match it in tech, aesthetic and production quality, so I need enough detail to reuse its exact patterns: palette hex values, the audio engine verbatim, the render helpers, the main loop skeleton, the screen/state machine, how input works, how the 8-bit look is produced.

Be exhaustive and quote real code. This brief is the foundation every downstream designer will build on.`,
  { label: 'recon:nostromo-gambit', phase: 'Recon', schema: RECON_SCHEMA }
)

const REF_BRIEF = `
=== REFERENCE IMPLEMENTATION BRIEF (nostromo-gambit — the quality bar) ===
Path: ${recon?.path}
Stack: ${recon?.stack}
Scale: ~${recon?.total_lines} lines of game code.
Files: ${recon?.files}
Aesthetic: ${recon?.aesthetic}
Audio: ${recon?.audio}
Architecture: ${recon?.architecture}
Reusable helpers: ${recon?.reusable}
UI language: ${recon?.ui_language}
Tone/feel: ${recon?.tone}
How to run: ${recon?.how_to_run}
Key code:
${recon?.verbatim_snippets}
=== END BRIEF ===
`

log('Recon complete — fanning out 4 independent designs + a dedicated algorithm track')

phase('Design')

const ANGLES = [
  {
    key: 'mechanic',
    prompt: `You are a hard-nosed SYSTEMS DESIGNER. Angle: MECHANICAL PURITY AND FUN.

Design the game's rules so that the adversarial-multiverse Battleship is genuinely FUN for a human, not merely clever. Attack these questions concretely and commit to numbers:
- Board size, fleet composition, and why. (Note: the possibility space must be large enough to feel like a multiverse but tractable in a browser.)
- Turn structure. Is the enemy also shooting at the player? If both fleets evade optimally, what stops the game from being a coin flip or a war of attrition? Where is PLAYER AGENCY and SKILL EXPRESSION?
- Resource economy: what currency does the player spend, how is it earned, what are the meaningful spend decisions each turn?
- The abilities implied by the source chat: a multi-branch munition ("особый снаряд ... накрыть сразу несколько альтернативных веток"), the Geller field (pin a region of reality so it can no longer shift), the Alcubierre drive (cross the brane). Turn each into a precise rule with costs and numbers. Cut any that does not earn its place.
- Is the classic 'salvo' (fire k cells simultaneously so the adversary must answer all k with ONE configuration) in? It is strictly stronger than k sequential shots against an adaptive defender — that asymmetry is a real skill lever.
- Failure and win conditions. Score. Why would a player replay?
- The DEGENERACY CHECK: name the dominant strategy a smart player will find, and the rule that prevents it. Also: does perfect information (showing the exact probability heatmap) trivialise the game? If so, what is shown instead?
- A difficulty curve / act structure across a single session.

Deliver a precise, numbered ruleset a programmer could implement without asking a question. Be opinionated. Prose, no fluff.`,
  },
  {
    key: 'feel',
    prompt: `You are a GAME FEEL / JUICE director working strictly within an 8-bit pixel aesthetic. Angle: MAKING SUPERPOSITION VISIBLE AND DELICIOUS.

The hardest problem in this game is that its core mechanic is INVISIBLE: an enemy fleet that is genuinely undetermined and reshapes itself. Your job is to make a player FEEL the multiverse collapsing under their guns, in 8-bit, on a canvas, at 60fps.

Design concretely:
- The GHOST FLEET rendering: faint flickering silhouettes of sampled valid placements over the enemy grid. How many samples per frame, at what alpha, flickering how fast, converging how, without looking like noise? Give the actual draw algorithm.
- The REALITIES COUNTER: a big number ticking down from millions (the Doctor Strange 14,000,605 reference). How is it animated? Odometer roll? Does a big collapse get its own beat — screen shake, freeze frame, sound?
- The moment of a HIT vs a MISS vs a KILL — three distinct, escalating pieces of feedback. A miss must still feel informative, because in this game a miss is a real constraint, not nothing.
- The moment the player PINS reality (Geller field): the visual of a region going from boiling probability to hard, stable, solid.
- Screen layout: two boards? one? HUD placement, at what canvas resolution, scaled how.
- Palette: give actual hex values, consistent with the reference game but distinct in mood — deep void, warp-taint, hard cold reality.
- Chiptune/SFX plan: what the music does as the reality count collapses (e.g. detuning/chorusing that resolves as the multiverse narrows). Specific oscillator/filter recipes using the reference game's audio engine.
- Title screen, transitions, death screen, victory screen.
- Three signature 'wow' moments a player will screenshot.

Be specific enough to implement. Prose plus concrete parameters.`,
  },
  {
    key: 'lore',
    prompt: `You are a NARRATIVE DESIGNER. Angle: LORE, NAMING, VOICE.

Build the fiction that makes the mechanic inevitable rather than arbitrary. Ingredients from the source chat: an Alcubierre drive that cannot move you in time but can move you across the brane into an adjacent reality where the ships stood differently; a Lovecraftian unknowable dark god that twists reality wherever you have not pinned it down; the Warhammer 40k Geller field as a bubble of stable reality inside the immaterium; "knights and liars in the multiverse of madness".

Deliver:
- The premise in 3 sentences. Who is the player, what are they hunting, why does the fleet exist in superposition, why does shooting collapse it.
- THE TITLE. The existing game is called 'Nostromo Gambit' — decide whether this should read as a companion piece (a '<X> Gambit' series) or stand alone, and commit to one title plus the folder name. Give 3 runners-up with one line each on why you rejected them.
- Naming for every mechanic and ability, in the game's voice.
- The dark god: does it act? Give it a mechanical presence, not just flavour — something that intervenes when the player leans on the multiverse too hard (a madness/corruption track).
- The opening text crawl / briefing (the actual text, written), the between-act interstitials, the victory and defeat text (actual text).
- Barks and one-liners: the enemy's answers to shots, in voice — this is a game where the enemy is LYING WITHIN THE RULES, so its voice should be smug, alien, and technically truthful.
- Language: match the reference game's in-game text language exactly (see the brief). If it is Russian, write all the actual text in Russian.
- Act/level structure: what changes between acts to escalate.

Write the real text, not descriptions of text.`,
  },
  {
    key: 'contrarian',
    prompt: `You are a CONTRARIAN LEAD DESIGNER whose job is to find the version of this game that is BETTER than the obvious one, and to protect the user from a clever-but-boring outcome.

The obvious design is: 8-bit Battleship, enemy cheats legally, big counter of remaining realities, ghost ships, Geller field pins a region. Assume that design will be proposed by others. Your job:

1. STRESS-TEST IT HONESTLY. Play it out in your head for 20 turns. Where does it get boring? Is "shoot a cell, watch a number drop" actually a game or a spreadsheet? Does an adversarial defender just make every shot feel like a miss — the classic problem with cheating Battleship, where the player is punished for good play? Name the real failure modes without mercy.

2. Then propose either (a) the fix that rescues it, or (b) a genuinely different game built on the same seed that is more fun. Candidate directions worth considering, but find better ones if you can:
   - Invert the roles: the PLAYER is the liar, defending a fleet in superposition against a relentless hunter, and the fun is in surviving impossibly long by reshaping reality. This directly solves 'the machine does the combinatorics for the human'.
   - Make it real-time or timed rather than turn-based.
   - Make it a puzzle game with hand-authored deduction scenarios rather than a random-board duel.
   - A roguelike run structure with escalating enemy admirals, each with a different evasion doctrine the player must read and counter.
   - Make the enemy's evasion DOCTRINE the thing you learn and exploit — a readable personality per opponent rather than a perfect optimiser (a perfect optimiser is unbeatable-feeling and boring; an exploitable liar with tells is a game).

3. Commit to ONE recommendation with a full ruleset, and state plainly what you are willing to lose from the obvious design to get it.

Be blunt. The user is asleep and cannot arbitrate, so your reasoning must stand on its own.`,
  },
]

const proposals = await parallel(ANGLES.map((a, i) => () =>
  agent(`${CONCEPT}\n\n${REF_BRIEF}\n\n${a.prompt}`,
    { label: `design:${a.key}`, phase: 'Design', agentType: 'Plan', effort: 'high' })
    .then(text => ({ key: a.key, text }))
))

const good = proposals.filter(Boolean)

phase('Algorithm')

const ALGO_SCHEMA = {
  type: 'object',
  properties: {
    approach: { type: 'string', description: 'the recommended algorithm for the adversarial defender, in full' },
    pseudocode: { type: 'string', description: 'concrete implementable pseudocode / JS for: representing the constraint set, sampling consistent configurations, choosing the maximally-evasive legal answer, and topping up the population' },
    counting: { type: 'string', description: 'how to produce the "N realities remain" number honestly — exact count where tractable, unbiased estimator otherwise. Name the estimator and its formula.' },
    perf: { type: 'string', description: 'concrete performance budget: board size, fleet, population size, ms per turn on a laptop browser, worst cases, and what to do about them (web worker? incremental? time-slicing across frames?)' },
    correctness: { type: 'string', description: 'proof sketch that the defender never lies: every answer given must be consistent with at least one complete valid placement. Also: how to guarantee the game is always winnable / terminates.' },
    salvo: { type: 'string', description: 'how simultaneous multi-cell shots are resolved against the population, and how region-probes (Geller field / count probes) are resolved' },
    pitfalls: { type: 'string', description: 'the failure modes: population collapse to zero, degenerate no-valid-configuration states, sampler bias making the counter lie, floating point, RNG determinism/seeding for replays' },
  },
  required: ['approach', 'pseudocode', 'counting', 'perf', 'correctness', 'salvo', 'pitfalls'],
}

const algoTrack = parallel([
  () => agent(`${CONCEPT}\n\n${REF_BRIEF}\n\nYou are an ALGORITHMS ENGINEER. This is the load-bearing technical risk of the whole project, and it must run in a browser inside an 8-bit game at 60fps with no build step and no dependencies.

THE PROBLEM: implement a Battleship defender that is allowed to rearrange its fleet arbitrarily between shots, provided every answer it has already given (hit / kill / miss) remains true of the new arrangement. It should answer each incoming shot in the way that maximally preserves its own freedom (maximally evasive), while never actually lying — i.e. every answer must be consistent with at least one complete legal fleet placement satisfying the entire history.

Additionally the game wants to display "N realities remain": the number of complete legal placements consistent with the history, starting in the millions and collapsing to 1.

Work the problem properly:
- Exact enumeration vs. sampling: at what board size and fleet does exact enumeration stop being tractable? Give real numbers for candidate configurations (e.g. 8x8 with ships [4,3,3,2], 10x10 with the classic Russian fleet [4,3,3,2,2,2,1,1,1,1], with and without the touching/adjacency rule).
- If sampling: how do you sample UNIFORMLY (or near-uniformly) from the set of consistent placements? Rejection sampling dies as constraints tighten — what replaces it? (Consider sequential importance sampling with weights, Metropolis/MCMC moves over placements, dancing-links / exact-cover style enumeration with memoised counting, DP over columns, or per-ship placement-mask intersection with propagation.)
- Counting: an unbiased estimator for the total count from a weighted sample, or an exact count via DP where possible. The counter is a headline UI element so it must not visibly lie or jitter absurdly.
- Answer selection: partition the population by the answer each configuration would give, pick the answer with the largest surviving mass; detail the 'kill' case (a kill reveals a ship's full extent — a huge constraint) and how to choose WHICH ship dies when several are consistent.
- Simultaneous salvos and region count-probes.
- Performance budget and where to put the work (main thread time-slicing vs Web Worker), and determinism (seeded RNG) so runs can be replayed.

Give real, implementable pseudocode or JS. This is the part that must not be hand-waved.`,
    { label: 'algo:defender-solver', phase: 'Algorithm', agentType: 'Plan', effort: 'high', schema: ALGO_SCHEMA }),

  () => agent(`${CONCEPT}\n\n${REF_BRIEF}\n\nYou are an ALGORITHMS ENGINEER working the SECOND half of the technical problem: the AI ATTACKER and the PLAYER-SIDE EVASION.

Context: this game is symmetric in principle — the enemy fleet evades the player's shots, and the player's own fleet evades the enemy's shots (the machine does the combinatorics for the human, because the source brainstorm explicitly noted a human cannot do it: "человеку такая комбинаторика может быть сложна").

Design and specify:
1. THE AI ATTACKER. It must feel smart but beatable, and must be TUNABLE across difficulty levels / successive opponents. Options: probability-density targeting over the consistent set (classic Battleship density heuristic), parity/checkerboard hunting, information-gain (entropy-reduction) targeting, and the deliberately imperfect variants that make an opponent readable and exploitable. Give the actual scoring function for choosing a target cell, and knobs for difficulty.
2. INFORMATION SYMMETRY. Both sides know only the answer history. Confirm this is sound and say exactly what state each side legitimately holds, so the AI never cheats in a way the player would resent.
3. PLAYER-SIDE AUTO-EVASION. The player's fleet dodges automatically. What should the player be able to STEER about it (a doctrine choice? a spend? a re-roll?), so it is a decision and not an autopilot. How is it displayed so the player understands what their fleet just did on their behalf and feels clever rather than passive.
4. EXPLOITABLE DOCTRINES. Specify 3-5 distinct evasion doctrines an opponent admiral could run (e.g. maximally-evasive, edge-hugging, cluster-hugging, mirror-the-player, greedy-survival), each with a mechanical definition, a visible TELL the player can learn to read, and the counter-strategy that beats it. This is what turns a perfect optimiser into a game.
5. Difficulty curve: concrete parameter tables per act/opponent.
6. Anti-frustration: what stops a run from becoming an unwinnable grind, and what guarantees a decisive ending.

Real, implementable specifications with scoring functions and numbers.`,
    { label: 'algo:attacker-and-doctrines', phase: 'Algorithm', agentType: 'Plan', effort: 'high' }),
])

phase('Critique')

const CRIT_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number', description: '0-100 overall' },
    fun: { type: 'number', description: '0-100: would a human actually enjoy 30 minutes of this' },
    feasible: { type: 'number', description: '0-100: buildable to nostromo-gambit quality in a single-file browser game' },
    fatal_flaws: { type: 'string', description: 'the flaws that would sink it, stated bluntly' },
    best_ideas: { type: 'string', description: 'the specific ideas from this proposal that MUST survive into the final design' },
    fixes: { type: 'string', description: 'concrete fixes' },
  },
  required: ['score', 'fun', 'feasible', 'fatal_flaws', 'best_ideas', 'fixes'],
}

const LENSES = [
  { key: 'player', q: 'THE PLAYER LENS. You are a jaded player who has played a thousand indie games. Is this actually fun, minute to minute? Where do you put the game down and never come back? Is the core loop a game or a spreadsheet? Be merciless.' },
  { key: 'build', q: 'THE IMPLEMENTATION LENS. You are the engineer who has to ship this as a self-contained browser game matching the reference project. What in this proposal is hand-waved, computationally infeasible at 60fps, or three times the scope it claims? What is the smallest cut that keeps the soul?' },
]

const critiques = await pipeline(
  good,
  (p) => parallel(LENSES.map(l => () =>
    agent(`${CONCEPT}\n\n${REF_BRIEF}\n\nHere is a design proposal for the game (angle: ${p.key}):\n\n<<<PROPOSAL>>>\n${p.text}\n<<<END PROPOSAL>>>\n\n${l.q}\n\nScore it and report.`,
      { label: `critique:${p.key}:${l.key}`, phase: 'Critique', agentType: 'Plan', schema: CRIT_SCHEMA })
  )).then(vs => ({ key: p.key, text: p.text, reviews: vs.filter(Boolean) }))
)

const reviewed = critiques.filter(Boolean)
const algo = (await algoTrack).filter(Boolean)

for (const r of reviewed) {
  const avg = r.reviews.length ? Math.round(r.reviews.reduce((s, v) => s + v.score, 0) / r.reviews.length) : 0
  log(`${r.key}: avg ${avg} (fun ${r.reviews.map(v => v.fun).join('/')}, feasible ${r.reviews.map(v => v.feasible).join('/')})`)
}

phase('Synthesize')

const bundle = reviewed.map(r => `
######## PROPOSAL: ${r.key} ########
${r.text}

---- CRITIQUES OF '${r.key}' ----
${r.reviews.map(v => `[score ${v.score} | fun ${v.fun} | feasible ${v.feasible}]
FATAL FLAWS: ${v.fatal_flaws}
MUST SURVIVE: ${v.best_ideas}
FIXES: ${v.fixes}`).join('\n\n')}
`).join('\n\n')

const algoBundle = `
######## ALGORITHM TRACK A — ADVERSARIAL DEFENDER SOLVER ########
Approach: ${algo[0]?.approach}
Pseudocode: ${algo[0]?.pseudocode}
Counting the realities: ${algo[0]?.counting}
Performance: ${algo[0]?.perf}
Correctness / never-lies: ${algo[0]?.correctness}
Salvos and region probes: ${algo[0]?.salvo}
Pitfalls: ${algo[0]?.pitfalls}

######## ALGORITHM TRACK B — AI ATTACKER, PLAYER EVASION, DOCTRINES ########
${algo[1]}
`

const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'the final game title' },
    folder: { type: 'string', description: 'the folder name to create next to nostromo-gambit' },
    pitch: { type: 'string', description: 'the game in 4 sentences, including why it is fun' },
    ruleset: { type: 'string', description: 'the complete numbered ruleset: board, fleet, turn structure, resources, every ability with costs, win/lose, scoring, act structure. Implementable without questions.' },
    engine: { type: 'string', description: 'the technical design: module breakdown, file layout, the solver, data structures, perf budget, seeded RNG, where work happens (main thread vs worker)' },
    presentation: { type: 'string', description: 'canvas resolution and scaling, palette hex values, layout, the ghost-fleet render algorithm, the realities counter, hit/miss/kill feedback, transitions, screens' },
    audio: { type: 'string', description: 'chiptune + SFX plan using the reference project audio engine' },
    text: { type: 'string', description: 'ALL the actual in-game text in the correct language: title, briefing, barks, interstitials, win, lose' },
    build_order: { type: 'string', description: 'the implementation order as concrete milestones, each independently verifiable, with what to check at each' },
    cut_list: { type: 'string', description: 'what was deliberately cut and why; what is a stretch goal' },
    risks: { type: 'string', description: 'the remaining risks and the mitigation for each' },
  },
  required: ['title', 'folder', 'pitch', 'ruleset', 'engine', 'presentation', 'audio', 'text', 'build_order', 'cut_list', 'risks'],
}

const spec = await agent(
  `${CONCEPT}\n\n${REF_BRIEF}\n\nFour independent designers and two algorithm engineers have worked this problem, and every design proposal has been adversarially critiqued by a jaded-player lens and an implementation lens. Here is everything:\n\n${bundle}\n\n${algoBundle}\n\nYou are the LEAD DESIGNER. Synthesize ONE final, buildable specification.

Rules for your synthesis:
- Take the highest-scoring skeleton, then GRAFT the best ideas the critics flagged as 'must survive' from the other proposals, including the contrarian's. Do not average — choose, then improve.
- Every fatal flaw the critics named must be either fixed or explicitly accepted with a reason.
- The algorithm track is authoritative on what is computationally possible. If a design idea is not implementable at 60fps in a dependency-free browser game, cut it or change it.
- Commit to specifics everywhere: numbers, hex colours, costs, cell counts, milliseconds. No 'could' or 'perhaps'. A programmer must be able to build this without asking a single question, because the user is asleep.
- Match the reference project's tech stack, file layout, aesthetic conventions and in-game text LANGUAGE exactly.
- The scope must be finishable to a polished state, comparable to the reference project's ~${recon?.total_lines} lines. Be honest in the cut list.
- Write the real in-game text, in the correct language.

This spec is going straight into a plan file and then straight into implementation.`,
  { label: 'synthesize:final-spec', phase: 'Synthesize', agentType: 'Plan', effort: 'high', schema: SPEC_SCHEMA }
)

phase('Verify')

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', description: 'SHIP or REVISE' },
    blocking: { type: 'string', description: 'blocking problems that must be fixed before implementation, with the specific fix for each' },
    gaps: { type: 'string', description: 'anything underspecified that a programmer would have to invent, plus the decision you recommend for each so nobody has to ask' },
    scope_check: { type: 'string', description: 'honest assessment of whether this is finishable to a polished state, and exactly what to cut first if it is not' },
  },
  required: ['verdict', 'blocking', 'gaps', 'scope_check'],
}

const SPEC_TEXT = `
TITLE: ${spec?.title}   FOLDER: ${spec?.folder}
PITCH: ${spec?.pitch}
RULESET:
${spec?.ruleset}
ENGINE:
${spec?.engine}
PRESENTATION:
${spec?.presentation}
AUDIO:
${spec?.audio}
TEXT:
${spec?.text}
BUILD ORDER:
${spec?.build_order}
CUT LIST:
${spec?.cut_list}
RISKS:
${spec?.risks}
`

const checks = await parallel([
  () => agent(`${CONCEPT}\n\n${REF_BRIEF}\n\n${algoBundle}\n\nHere is the final spec:\n${SPEC_TEXT}\n\nYou are an ADVERSARIAL FEASIBILITY REVIEWER. Default to skeptical. Try to REFUTE the claim that this is buildable, at 60fps, dependency-free, to the polish level of the reference project, and genuinely fun. Attack: the solver's performance under tightening constraints; the honesty of the realities counter; whether the game is winnable and terminates; whether the fun survives contact with an adversarial defender; whether the scope is 2x what is claimed. For every problem, give the specific fix.`,
    { label: 'verify:feasibility', phase: 'Verify', agentType: 'Plan', effort: 'high', schema: VERIFY_SCHEMA }),

  () => agent(`${CONCEPT}\n\n${REF_BRIEF}\n\nHere is the final spec:\n${SPEC_TEXT}\n\nYou are a COMPLETENESS CRITIC. The user is ASLEEP and cannot answer a single question, so anything left underspecified will be invented badly at 3am. Enumerate every decision a programmer would still have to make: exact grid pixel sizes, keyboard AND mouse bindings, what happens on window resize, mobile/touch, whether progress persists, the exact fleet, the exact starting resource values, the pause behaviour, what the first 10 seconds of play look like, accessibility of the colour choices, what happens on an illegal input, edge cases at the end of the game. For EACH gap, state the specific decision you recommend so the spec can be closed out. Do not restate what is already specified — only the holes.`,
    { label: 'verify:completeness', phase: 'Verify', agentType: 'Plan', effort: 'high', schema: VERIFY_SCHEMA }),
])

const v = checks.filter(Boolean)

return {
  reference: recon,
  spec,
  algorithm: algo[0],
  attacker_and_doctrines: algo[1],
  feasibility: v[0],
  completeness: v[1],
  scores: reviewed.map(r => ({
    angle: r.key,
    avg: r.reviews.length ? Math.round(r.reviews.reduce((s, x) => s + x.score, 0) / r.reviews.length) : 0,
    fun: r.reviews.map(x => x.fun),
    feasible: r.reviews.map(x => x.feasible),
  })),
}

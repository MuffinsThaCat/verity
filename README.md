# Verity

**An encyclopedia where every sentence has a price.**

Each claim is a perpetual prediction market on NEAR. There is no oracle and nothing resolves: the price is the crowd's current
confidence that the sentence is true. AI agents earn by correcting what is wrong and lose money for pushing the wrong way, and
the article is regenerated from the prices. Nobody edits it.

> Built for the NEAR Hackathon (tracks: AI Swarms, Agent Economy, Open Innovation).
> Start with [DESIGN.md](DESIGN.md) for the mechanism and, more usefully, what it does **not** prove.

## See it work (local, about a minute, no API key)

Needs Node 20 or newer. License: MIT for the code (`LICENSE`); the cached Wikipedia pages in `seed-cache/` are CC BY-SA 4.0. The contract is already built (`contracts/verity/res/verity.wasm`); Rust 1.86 is needed only to rebuild it
(`npm run build:contract`). The first `npm run demo` downloads the local NEAR node it runs on (a 53 MB nearcore binary, once);
`npm run fetch-node` does that ahead of time. `npm run test:ui` needs Chrome (set `CHROME` to its path if it is not the macOS default).

```bash
git clone https://github.com/MuffinsThaCat/verity && cd verity
npm install
npm run build
npm run warm          # optional: the pages the demo reads ship in seed-cache/; this refreshes or extends them (see below)
npm run demo          # a real local NEAR node + the real contract + five agents + the UI at http://localhost:8787
```

You get four articles (Pluto, Mount Everest, Apollo 11, the Solar System), each with sections, numbered references and a
contents box, written from market prices. Five agents work them as two squads, each a researcher and a skeptic with its own
NEAR account, plus an arbiter that watches contradictions across all of them.

**Hands-free tour:** open `http://localhost:8787/?autopilot=1` (or press **▶ Autopilot**, bottom left). A visible cursor clicks the real buttons and captions say what is happening: the article, a sentence's market, the swarm, then both stories below, then Verify. It waits on the page itself, so it takes as long as the agents take; Esc stops it, and `&pace=1.5` slows the captions for a calmer recording. It is the same app, not a recording. `AUTOPILOT=1 npm run test:ui` checks that it runs from the first caption to the last.

Two stories are built in, and they are the two halves of the idea. **▶ Play: add a sentence** adds a *true* sentence (for example *"Charon was discovered in 1978."*) at 50%, with no one having checked it, and narrates the agents reading Wikipedia, quoting it, posting the evidence on chain and betting until the price settles high: the encyclopedia growing. Or write your own sentence in the box below it. The lie story below is the contrast: the same pipeline refutes a false sentence.

Press **▶ Play the story** (or pick a lie and **Inject**). It injects *"Pluto has twelve known natural satellites."* backed
with 2 NEAR, so the claim enters the article at 94%. Then you watch what actually happens, narrated from the chain and the
activity log rather than a script:

1. an agent reads the Wikipedia page on Pluto's moons and must **quote it word for word** (a quote that is not in the page voids
   the verdict, enforced in code);
2. the source is posted on chain as **evidence**: its address, the sha256 of its content, the quote, and a bond;
3. the arbiter trades the contradiction with the true claim, the skeptic bets against the lie citing the evidence: the price drops in two to four steps (for example 94% → 25% → 9%, or 94% → 48% → 14%) and ends between 6% and 15%;
4. below 30% the sentence leaves the article and a revision is recorded;
5. **your browser** fetches that Wikipedia revision itself, hashes it, and compares with the chain; it also checks that the revision belongs to the page the source is labelled as, and that the quote the agent posted is really in the page;
6. you cash out and see what the lie cost you (4.9 to 6.1 NEAR in six measured plays, one of each lie). That money went to the agents that corrected it.

**Verify** buttons on every reference and every evidence card do step 5 for any source. Wikipedia's API allows cross-origin
reads, and the wikitext it returns hashes to the same value as the raw page the agents fetched, so the check runs in the
reader's browser rather than on this server. It checks three things: the hash, the page title, and that the quote is in the
page (reduced to text by the very module the agents run, which the server hands to the browser). What it cannot remove is
trust in Wikipedia and in the connection to it. Without it, nothing stops an agent posting a real hash beside an invented
quote; that is the case the quote check exists for.

### Which revision of a page is read

Not the latest. The newest revision of a page is its least reviewed, and a vandal's edit that says a lie is true would be read,
pinned and cited, and would then pass Verify, because the hash really is that revision's. The agents read the newest revision
that is at least 24 hours old (`VERITY_MIN_REVISION_AGE_HOURS`; 0 reads the latest). That costs one extra lookup only for a page
edited within the day, and a page with nothing that old is not used. It narrows the window to vandalism that survives a day of
review; it does not make Wikipedia true, and a real correction takes a day to reach the agents.

### Why `npm run warm`, and `seed-cache/`

The repository ships the pages the demo reads (`seed-cache/`: 130 pages and 160 searches, 4.3 MB, pinned revisions, with Wikipedia's CC BY-SA attribution in its README). The first time `data/cache` is empty it is filled from there, so a fresh clone runs `npm run demo:offline` with no Wikipedia access at all (after `npm run fetch-node` for the local node, below). `npm run warm` is for extending it or refreshing it.

Wikipedia limits anonymous clients. The agents share one rate limiter that backs off on HTTP 429, and every pinned revision is
cached on disk (a revision id names fixed content, barring the rare deletion or suppression of a revision, so a cached page does not go stale). `npm run warm` fetches everything the demo will
ask for. After that `npm run demo:offline` (`--offline`, the same as `VERITY_CACHE_ONLY=1`) reads no Wikipedia, and the hashes it posts still match what
`curl | shasum` gets from Wikipedia. It still needs the local NEAR node binary on disk: run `npm run fetch-node` once while you have a network, or the first start downloads it. Please set `VERITY_USER_AGENT` to something with a real contact before running it at scale;
Wikimedia asks for that.

### The judge

Three modes, chosen by environment:

| Mode | Judge | Sources | Needs |
|---|---|---|---|
| default | **rule-based** (words, figures, names; labelled "rule-based judge (no model)" in the header) | real pinned Wikipedia | nothing |
| `ANTHROPIC_API_KEY`, or `LLM_BASE_URL` + `LLM_API_KEY` | language model, schema-checked | real pinned Wikipedia | a key |
| `VERITY_MOCK=1` | the rule-based judge | a tiny static corpus | nothing, no network |

The rule-based judge reads no meaning. It finds the sentence that shares the most content words with the claim and names
everything the claim names, compares each figure only with a figure that counts the same thing, and declines (no trade) when it
cannot tell. It is conservative on purpose: a refutation needs a focused sentence, not one that merely shares words. Its failure
cases found on live Wikipedia are now regression tests (`test/offline.test.ts`). A claim that is wrong in a way it cannot see,
such as a swapped name, gets no refutation from it; that is what the model mode is for. Negation is handled cautiously, because where a negation ends cannot be read from words: a claim that
contains one ("Pluto is not a planet", "Pluto does not have twelve moons") is never refuted from an affirmative sentence, because
that sentence may be restating it, and this holds for claims with figures too; and a sentence that negates part of an
affirmative claim counts only as a weak argument against it, never as support. Every verdict from either judge still has
to quote the page verbatim.

## How it works

```
                 ┌────────────────────────── NEAR ──────────────────────────┐
 Researcher ──┐  │ claim market (fixed-product AMM, fully collateralised)   │
 Skeptic    ──┼──▶ evidence = URL + sha256 + stance + bond                  │──▶ server ──▶ article, sections,
 Arbiter    ──┘  │ link market: "A implies B", "A excludes B"               │              references, swarm, feed
   ▲             │ get_violations  get_accounting (solvency audit)          │                    │
   │             └──────────────────────────────────────────────────────────┘                    ▼
   └── pinned Wikipedia revisions ─▶ judge ─▶ verdict kept only if its quote is verbatim     your browser re-hashes
                                                                                              each source itself
```

- **Claims** are binary markets that never resolve. Buy YES or NO, sell back to the pool any time.
- **Articles and sections** are topics: `pluto` is an article, `pluto/moons` a section of it. The first path segment is the article.
- **Evidence** is a URL plus the sha256 of what was fetched, with a stance and a bond. The bond comes back only if trades cite the evidence for at least the bond. Anyone may call `settle_bond` once the window has passed, and nothing in the contract does it by itself, so the arbiter doubles as a keeper and settles matured bonds on every pass (`src/agents/keeper.ts`).
- **Links** between claims are markets too, even between articles, so contradictions are priced. `get_violations` lists inconsistent pairs weighted by how much the crowd believes the relation.
- **The article** is a deterministic reading of the prices: sections, numbered references, citations on every sentence. Below 30% a claim leaves the body. A model may write a lede, but every paragraph must cite claim ids and may only lean on claims the market backs.
- **Agents** are ordinary accounts spending their own NEAR, sized by fractional Kelly and capped per trade. They act on the most relevant source, not the most extreme one, and halve their conviction when another relevant source disagrees. The contract trusts none of them.
- **The swarm panel** shows each agent's current task, sources read, trades and profit. Profit values positions at what selling them *now* would pay (`quote_sell`), not at spot, because a thin pool pays less than its price.

## What has actually been run

| Check | Result |
|---|---|
| Contract unit tests (`npm run test:contract`) | 40 pass: AMM invariants under 3,000-step and 1,500-step random walks, a 4,000-step walk that mixes every operation with the accounting audit after each step, the violation scan reading the newest 64 links and walking back to older ones, solvency identity, rounding, evidence bonds, links (more than 60 of them, symmetric duplicates), evidence slots and surcharge, a new trader's quote, a claim at every limit still being paid for by its fee, validation |
| TypeScript tests (`npm test`) | 137 pass: Kelly sizing with weighted stakes, slippage retries (agents and arbiter), review locks, the stable-revision policy, the text cleaner against its regex original and against hostile pages, the bond keeper, source choice, the rule-based judge and its false-positive regressions (including negation), rate-limit backoff, the disk cache, host allowlist, redirect handling and the streamed size cap, quote-aware verification, article sections and references, seed validation and cost, activity tail |
| End to end on a real local NEAR node (`npm run e2e`) | 22 of 22 pass: deploy, agents trade, the lie is refuted, bonds settle, guards reject bad trades, the server records revisions, the swarm panel's positions equal what the chain says selling would pay, evidence verification (including refusing an internal address), a second article, cross-article contradictions, server hardening (raw-socket path traversal, one demo action at a time, a page read straight after a write), a settled bond showing as settled, the keeper settling matured bonds, two agents running at once posting a source once, a payout to a deleted account being stranded and accounted, solvency |
| Live Wikipedia | the rule-based judge was developed against about 50 real claims and lies, and on the final build all 29 seed claims and lies were re-checked from the cache: every claim is supported and every lie refuted (the false refutations it produced early on are fixed and pinned by tests); an independent `curl \| shasum -a 256` reproduces the recorded hash |
| UI (`npm run test:ui`, against a running demo) | 9 of 9 pass in headless Chrome (`STORY=1` for the stories; Verify needs `VERIFY=1`): sections, citations, tabs and arrow keys, the market panel, the swarm, the whole guided lie story and "Play another" straight after it, the add-a-sentence story (enters at 50%, ends at 70% or more, costs about 1 NEAR), phone width. In-browser Verify (hash, title, quote) on live Wikipedia is the same check with `VERIFY=1`. Each of the six lies in the picker was also played through the story, one after another: each entered at 94%, ended between 6% and 15%, and cost 4.9 to 6.1 NEAR; the check now asserts the same shape (starts at 94%, ends under 30%, costs 3 to 8 NEAR). Dark mode was looked at, not asserted |

**On testnet:** deployed (`verity1-contract.verity-admin.testnet`) and run once end to end on 2026-11-08: `bootstrap`, `split-env`, `check-code` (MATCH), `seed`, the three agents and the server with the demo controls. Two true sentences added through the demo were confirmed by the agents (Mars 50% to 80.5%, Charon 50% to about 77%). It needs a keyed RPC and funded agents (see DEPLOY.md); the guided lie story was not played there.

**Not done:** the browser wallet path (only the demo account path was exercised), a load test of the
larger views, a run with a language-model judge (no API key was available). See the end of [DESIGN.md](DESIGN.md).

## Layout

```
contracts/verity/     Rust contract (near-sdk 5.9, toolchain pinned to 1.86), res/verity.wasm is the build
src/lib/              chain client, sources (Wikipedia, rate limiter, disk cache), judges, LLM clients, activity log, which articles are followed (scope.ts)
src/agents/           analyst (researcher + skeptic personas), arbiter, runner
src/article.ts        bands, sections, references, revision diff, lede writer
src/demo/             seed loader and validator, the offline corpus
src/server.ts         polls the chain, records revisions, serves the API (articles, swarm, verify, lies) and the UI
web/                  the reading UI (no build step)
scripts/              demo, fetch-node, warm, bootstrap, split-env, seed, check-code, verify-evidence, measure-scan-gas, measure-call-gas, measure-topics-gas
test/                 unit tests and the sandbox end-to-end test
seed/                 four articles: claims by section, links (including across articles), and the lies the demo offers
```

## Deploying

See [DEPLOY.md](DEPLOY.md). Submission checklist and video script: [SUBMISSION.md](SUBMISSION.md).

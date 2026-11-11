# Verity: design, and what it does not prove

## The idea in one paragraph

Language models hallucinate because being wrong is free. Wikipedia decays because being right pays nothing. Verity prices
both. Each claim is a binary market that **never resolves**, so there is no oracle to trust and no date to wait for: the
price is the crowd's current confidence that the claim is true. Agents earn by moving prices toward what a checkable source
says, and lose money when they push the wrong way. The article is not stored anywhere. It is a reading of the prices.

## What is mechanism, what is policy

| Layer | Where | What it guarantees |
|---|---|---|
| Market | `contracts/verity` | A claim's pool is always fully collateralised. `collateral == YES supply == NO supply` is checked on every trade, and `get_accounting` exposes `total_in - total_out == liabilities + kept` for anyone to audit. Rounding always favours the pool. |
| Evidence | `contracts/verity` | A source is recorded with a URL and a sha256 of its content. A bond is returned only if trades cite the evidence for at least the bond. |
| Links | `contracts/verity` | A relation between two claims is itself a market, so the crowd prices whether the relation holds. `get_violations` reports inconsistencies weighted by that price. |
| Agents | `src/agents` | Off-chain policy. Nothing on chain trusts them. They are ordinary accounts spending their own NEAR. |
| Judge | `src/lib/judge.ts` | A verdict counts only if its quote appears **verbatim** in the fetched source. This is enforced in code, not in the prompt. |
| Article | `src/article.ts` | Deterministic from prices. A model may write the lede, but every paragraph must cite claim ids, and a paragraph that leans on a claim the market does not back is discarded. |

## The market: a fixed-product AMM, integer only

NEAR's VM rejects floating point, so LMSR (which needs `exp` and `ln`) is out. Verity uses the Gnosis-style fixed-product
market maker over YES and NO shares:

- price(YES) = `r_no / (r_yes + r_no)`.
- Buying YES with `net` of collateral mints `net` of each share, adds the NO to the pool, and shrinks the YES reserve so
  that `r_yes * r_no` does not fall. The buyer receives the YES that left the pool.
- Selling solves `(r_x + s - g)(r_o - g) = k` for the released collateral `g`. The discriminant is
  `(r_x + s - r_o)^2 + 4k`, so there is no subtraction that can underflow. The square root is rounded up, which rounds `g`
  down, in the pool's favour.
- Internal units are ticks of 1e12 yocto so that products of reserves fit in `u128`. A market is capped at 100,000 NEAR.
- There is no resolution and no redemption. A holder exits by selling back to the pool.

Tests that matter (`cargo test`, 40 of them): the product never decreases over 3,000 random buy/sell steps; a 1,500-step
random walk by three accounts keeps the supply invariant and a running liabilities counter equal to a full recompute after
every step; a 4,000-step walk that mixes every operation (buys citing evidence, sells, evidence posts and replacements, bond
settlements, fee withdrawals, links) keeps the accounting identity after each one; a round trip never profits and costs only
fees; quotes equal executions.

## The evidence bond, and a bug I found by running it

Evidence carries a bond (minimum 0.02 NEAR) plus a non-refundable storage fee (0.01 NEAR) and a surcharge of an eighth of that fee for each piece already on the claim. `settle_bond`, callable by anyone after the
bond window, refunds the bond if the capital behind trades citing the evidence is at least the bond, and otherwise sends it
to the claim's fee pool.

The first version counted only *other* accounts' capital as backing. The end-to-end test failed, and the failure was
instructive: once the first agent corrects a price, followers have no edge left and rationally do not trade, so the honest
first mover's bond was forfeited. The exclusion also bought almost no security, because a second account wash-trades at the
same ~2% fee. So backing now counts all cited capital, the author's included, and a separate `independent` figure counts only
other accounts. The bond means "put at least this much money in the market behind your source", and the UI ranks evidence by
the independent part.

Two small behaviours worth knowing. Evidence `backing` keeps counting after its bond has settled: the capital behind a source
is real and the UI ranks by it, but only what had accumulated when the window closed decided the bond. And the first time an
account trades a claim it pays 0.002 NEAR for its position entry, which `quote_buy` now includes when it is told the account
(`quote_buy(claim_id, side, amount, account)`); the server passes the demo account or a wallet's, and the agents pass their own.

## What anchors price to truth? (the question to ask)

Not an oracle. In a market that never resolves, a price is whatever the last trader was willing to pay. Nothing in the
contract forces it toward the truth. The thesis is narrower, and it is a hypothesis the demo tests rather than a theorem:

> If checking a claim is cheap for a population of automated verifiers, then holding a false claim at a high price is a
> standing subsidy to whoever checks it, and the price converges toward what a checkable source says.

Three things make that more than a slogan, and three things stop it from being a proof.

Making it concrete: a judge's quote must exist verbatim in a source whose hash is on chain, so the *input* to a trade is
checkable by anyone with `curl | shasum`; an agent that lies about a source is caught by the hash script
(`npm run verify-evidence`); and the liar pays, which the end-to-end test measures (in one end-to-end run a saboteur who pumped a false claim to
~95% lost ~3.9 NEAR once agents responded; over the six lies of the guided story, which seed 2 NEAR and pump 2 NEAR, the cost
measured 4.9 to 6.1 NEAR).

Stopping it from being a proof:

1. **Verifiers are an assumption.** If no agent is watching, a false claim stays priced high. The mechanism pays verifiers; it
   cannot summon them.
2. **A thin market is cheap to move.** Pool depth is the security budget. In a demo run a 2 NEAR pool moved from 94% to 25% on a
   single 1.5 NEAR trade. That is the same fact seen from the defender's side. Seed deep or expect volatility.
3. **The verifier can be fooled.** A judge model can be wrong, or be shown a bad source. Its damage is capped by the agent's
   own per-trade limit, the quote check, and the fact that its evidence sits on chain for others to dispute with money.

## Contradictions are a convergence trade, not an arbitrage

The earlier pitch said contradictions are "free money". With nothing resolving, they are not. If A implies B and the market
prices A above B, then buying NO on A and YES on B pays at least 1 in every logically possible world *if the market ever
settled*, but it never does. The profit is realised only if the two prices move together before you exit. The arbiter is
therefore labelled a convergence trader, and it cannot tell which side of the contradiction is wrong: in the end-to-end run
it pushed a *true* claim down along with the false one, and the evidence-reading agents then pushed the true claim back up.
That is the honest dynamic, and the test asserts it.

A link is itself a market, so a bad link is priced down by the crowd and drops out of `get_violations` once its price is
below the caller's confidence threshold. This also means a spammer cannot manufacture "arbitrage" by posting a wrong link
without paying to defend it.

## Attack surface and known limits

| Issue | Status |
|---|---|
| Topic squatting: a topic is capped at 60 claims (to keep views inside the gas limit), so someone can fill it | Costs 0.07 NEAR unrecoverable per claim; not otherwise mitigated. Topic curation is out of scope. |
| Link markets: all of them share the reserved topic `meta:links` | These were once counted against the 60-per-topic cap, which limited the whole contract to 60 links. Links are no longer listed under a topic (read them with `get_links`), so the number is bounded only by the 64 links a claim may carry. `get_claims_by_topic("meta:links")` returns nothing. |
| Link slots on a claim | A claim carries at most 64 links. Every lie a visitor injects adds one to the true claim it contradicts, so the limit has to leave room for a demo being replayed (it was 16, and about fifteen plays of one lie exhausted it). A contract test builds a claim at every limit and checks the 0.07 NEAR claim fee still pays for its storage. The 65th link is refused; the server reports that as a warning next to the lie, which is already live, instead of failing the whole action. Filling a claim's slots to block contradiction links costs 64 × 0.07 = 4.5 NEAR in fees plus at least 0.5 NEAR of seed liquidity per link (recoverable, less fees), a little more than blocking evidence, and is not mitigated. A topic holds 60 claims and each replay of a lie opens one, so the server sends a lie to the article's lead when its section is nearly full, and says so when both are. |
| Duplicate links | "A excludes B" and "B excludes A" are the same statement and are refused as duplicates; "A implies B" and "B implies A" are different and both allowed. |
| Filling a claim's evidence slots to lock honest sources out (a claim holds at most 64) | Each piece of evidence already on a claim adds an eighth of the 0.01 NEAR fee to the cost of the next (paid into the claim's fee pool), so the 64th costs about 0.09 NEAR and filling all 64 costs about 3.2 NEAR (0.64 in fees, 2.52 in surcharges). The fees are unrecoverable; the surcharges go to the claim creator's fee pool, so they are unrecoverable to an attacker only when the claim is someone else's. One account may hold at most 8 slots, so it takes at least 8 accounts. A full claim makes room by dropping evidence whose bond was *forfeited* (nobody ever backed it), so junk has to be backed with real capital to stay. Not free, and not impossible: a determined attacker with a few NEAR can still crowd one claim. |
| Evidence is not permanent on a full claim | When a claim is full, a new piece of evidence replaces one whose bond was *forfeited* (nobody ever backed it). The old record stays in the contract and can be read by id (`get_evidence`); only its place on the claim is reused. This includes an honest agent's evidence that was forfeited only because its trade failed, which is why the agents retry a refused trade instead of leaving the evidence uncited. |
| A vandalised Wikipedia page | An agent that reads a page the minute a vandal's edit lands would pin that revision and cite it, and Verify would mark it verified, because the hash really is that revision's. Verify proves what a page said, not that it was right. The provider therefore reads the newest revision at least 24 hours old (`VERITY_MIN_REVISION_AGE_HOURS`, 0 to read the latest), which costs one extra lookup only for a page edited within the day, and skips a page with nothing that old. This narrows the window to vandalism that survives a day of review, and it also means a real correction takes a day to reach the agents. |
| A page built to stall the verifier | Anyone can post evidence pointing at a Wikipedia revision they wrote (their own user page, say) and a note quoting it, and `/api/verify` and the Verify button then reduce that page to text. Reducing markup with regexes such as `<ref[^>]*>[\s\S]*?</ref>` takes quadratic time on a page of unclosed openers, so 2 MB of them would stall the server's one thread, or a visitor's tab, for minutes. `cleanWikitext` is now a set of single-pass scanners. `test/wikitext.test.ts` keeps the regex version, checks both give the same text on 6,000 random bracket-and-tag inputs (400,000 in a one-off run, and 14 full Wikipedia articles), and cleans 14 hostile 2 MB pages in a few seconds each at most. The judge's own text functions run only on pages the search returns, not on pages an attacker chose. |
| Payouts to an account that no longer exists | The transfer fails and the NEAR stays in the contract. Every payout now carries a callback: a failed one stops counting as paid out and is booked as `kept` and `stranded` (both in `get_accounting`), so the accounting identity stays true and the amount is visible. There is no way to reclaim it. |
| Wash trading to fake evidence backing | Costs ~2% in fees per round trip. Backing is a spam filter, not a truth signal. |
| The contract's deploy key | `bootstrap` leaves a full-access key on the contract account and saves it in `.env.generated` as `CONTRACT_PRIVATE_KEY` (an earlier version said it did and did not). Delete the key on the account for an immutable contract; keep it if you want upgrades. There is no admin function in the contract itself. |
| Gas on big views | Measured on a sandbox node with every limit filled (`npm run measure:calls`, and `npm run measure:topics` for the topic list): `get_claims`, a page of 50 full claims (48-trade tapes): 67.8 Tgas; `get_claims_by_topic`, 60 full claims: 82.5 Tgas; `get_claim_evidence` with 64 pieces: 10.2 Tgas; `post_evidence` as the 63rd, the 64th, and on a full claim replacing a forfeited piece: 8.1, 8.2 and 8.3 Tgas (the agents send 80); `create_link` as the 64th link on a claim: 8.2 Tgas. Views may use 200, so the two claim lists have a margin of 2.4 to 2.9 times. `get_topics` was unbounded: 0.077 Tgas a topic, so about 2,560 topics (roughly 180 NEAR of fees for someone to open them) would have made it fail and blinded the server and the agents. It now returns a page (at most 200, 17 Tgas whatever the list's length) and the server and agents read it with a `TopicIndex` that keeps what it has read and asks only for topics added since. `get_violations` looks at the newest 64 links per call and takes a `before` index to walk back through older ones (the server and the arbiter read three windows, 192 links). A link costs four storage reads, and a read of a key nothing else in the call has read costs about 0.25 Tgas whatever its size, so the cost is set by how many *different* claims are read. Measured on a sandbox node with full 48-trade tapes and 49-character account names (`npm run measure:scan`): 64 links over 128 distinct claims cost 66 Tgas (1.0 Tgas a link) against the 200 a view call may use; 40 distinct links cost 42. When the same claims are read again and again the cost is lower: 91 links over 14 claims cost 0.236 a link, 28 links over 8 claims 0.288. An earlier version of this row said a scan of 200 links cost about 48 Tgas; that came from the reused-claims fixture, and the worst case is about 202 Tgas, over the limit, which is why the window is 64. `get_accounting` is O(1). |
| Front-running | Trades carry `min_shares` / `min_proceeds`; the quote views let a client set them. Nothing prevents sandwiching on a public mempool. |
| Prompt injection | Claim text and source text are untrusted data inside delimiters with closing tags stripped, and the judge's output is a constrained schema checked in code. Not red-teamed. |
| Wikipedia as the only source | Pinned revisions are reproducible but Wikipedia is not truth. The provider is an interface; adding sources is the obvious next step. |
| Money | Native NEAR is the collateral. No stablecoin, so prices of collateral drift against fiat. |

## Three operating modes

| Mode | Judge | Sources | Needs | Set by |
|---|---|---|---|---|
| **LLM** | Language model with schema validation + verbatim quote check | Real pinned Wikipedia revisions | An API key (`ANTHROPIC_API_KEY` or `LLM_BASE_URL` + `LLM_API_KEY`) | Having a key |
| **Rule-based** (default when no key) | Words, figures and names + verbatim quote check | Real pinned Wikipedia revisions | Network, or a warm cache | No key, no `VERITY_MOCK` |
| **Static mock** | Same rule-based judge | Tiny hardcoded corpus | Nothing | `VERITY_MOCK=1` |

### What the rule-based judge will and will not do

It reads no meaning. For a claim it (1) finds the sentence sharing the most content words that also names everything the
claim names ("Apollo 11" with its number, every capitalised name), (2) compares each figure in the claim only with a figure that
counts the same thing (moons with moons, a year with a year, "the second person" with "the first person"), (3) calls equal
figures support and a different figure a refutation, and (4) otherwise declines.

It was built by running it against live Wikipedia and fixing what went wrong, and the failures are the point:

- *"Pluto has five known natural satellites"* was refuted by a sentence about the Solar System's eight planets (a figure
  compared with an unrelated figure). Fix: figures are compared only when the noun they count matches.
- *"Pluto takes about 248 years to orbit"* was refuted by "for every two orbits that Neptune takes" (the verb was read as the
  unit). Fix: the unit is the first noun after the figure.
- *"The height of Mount Everest is 8,848.86 metres"* was refuted by "a moss grows at 6,480 m on Mount Everest" and by
  "reached an altitude of 8,321 m" (same entity, same unit, a different thing). Fix: a refutation needs a sentence that names the
  subject itself (not one that borrows the article title) and has at least 80% of the claim's words within eight words of the
  conflicting figure. A conflict that fails this stops the sentence supporting the claim; it does not silently disappear.
- *"…first confirmed ascent of Everest in 1963"* was **supported** by a sentence containing 1953 once that conflict was dropped.
  Fix: the doubtful conflict blocks support.
- A sentence about Armstrong and Aldrin supported a claim about Collins. Fix: every named thing in the claim must be in the sentence.
- A page about fictional planets disagreed with the real article. Fix: lists, outlines, timelines and "fictional" pages carry
  70% of the weight, and an agent only counts a dissenting source that is nearly as relevant as the one it follows.

- *"Pluto is a planet"* (a natural lie) was **supported** by "Pluto is no longer considered a planet", because the negation
  was only looked for three words ahead; "planet" is the fifth word after "no". It now looks six words ahead inside the clause.
- *"Pluto is not a planet"* (a true claim) was **refuted** by "Pluto is a dwarf planet", because the sentence had no negation.
  A negated claim cannot be judged from an affirmative sentence (it may restate the claim), so the judge now stays silent
  unless the sentence also denies it. That rule is applied *before* figures are compared: "Pluto does not have twelve moons"
  is true, and comparing 12 with Wikipedia's "five" had refuted it.
- Where a negation ends cannot be read from words ("Pluto is not the largest dwarf planet" does not deny "a dwarf planet"). Scoped
  negations ("not the largest", "not only", "not all") are now skipped, and a sentence that negates part of an affirmative claim
  is a *weak* argument against it and can never count as support, whatever its word overlap. "Weak" has to reach the agent's
  sizing to mean anything: belief 0.3 under Kelly was still close to a full-size bet, so the verdict now carries belief 0.4 and a
  `weight` of 0.35, and the agent stakes that fraction of what it would on a clear reading.

- *"Buzz Aldrin was the first person to walk on the Moon"* (a lie) was **supported** by "Aldrin became the first person to hold a
  religious ceremony on the Moon", on newly pinned older revisions. The ordinal "first person" agrees whatever was done first, and
  three of five words overlapped. When an ordinal is the only agreement, the judge now needs three quarters of the claim's words.
- A long subject ("Tenzing Norgay and Edmund Hillary made the first documented ascent of Everest in 1963") pushed its figure out of
  the eight-word window around the names, so the sentence that refutes it was judged "not clearly about the claim". The window now
  measures what is claimed (its words apart from its names, which the explicit-name check already covers), still rejecting the
  moss on Everest, whose sentence has no word about height near its figure.

Each is a test in `test/offline.test.ts`. Changing which revision of a page is read changed what the judge saw: two demo lies
stopped being refuted until the cases above were found, which is why the 29 seed claims and lies are re-judged after any change
to the provider or the judge. What remains: a claim that is wrong in a way no figure shows (a swapped name, an
inverted relation) gets **no refutation** from this judge, only silence. That is the intended failure: it declines rather
than trades on a guess. A language model is the right tool for those, and the pipeline around it is the same.

### Why agents act on the most relevant source

The first version acted on the verdict with the largest edge. On real pages that rewards noise: the most extreme reading from the
least relevant source wins, so an agent bought NO on a true claim. Agents now follow the most relevant source and halve their
conviction when another source of comparable relevance disagrees (`chooseReading`).

## Checking a source yourself

Every reference and evidence card has a **Verify** button. The browser fetches the revision from Wikipedia's Action API (which
allows cross-origin reads), hashes the UTF-8 bytes of the wikitext with `crypto.subtle`, and compares with the hash on chain.
This works because that text hashes to exactly the bytes the agents fetched from the raw endpoint (checked on five revisions,
38 to 257 KB). It then checks two more things, because a matching hash alone proves less than it seems to:

- **The page title.** An evidence URI carries a `title=` parameter that is only a label; MediaWiki serves revision `oldid` whatever
  the title says. The browser compares the title the API returns for that revision with the label.
- **The quote.** Only a note written as a quotation counts as one (`quotedText`): a note is free text, and commentary or a
  very short note must not be reported as a quote missing from the page. The hash says which page the agent read, not that the quote it posted is in it, and the contract cannot check
  that. The browser reduces the page to text with `cleanWikitext` and looks for the quote, ignoring case, spacing and quote
  marks. That function lives in `src/lib/wikitext.ts`, which has no imports; the server serves its compiled form at
  `/lib/wikitext.js`, so the agents and the reader's browser run the same code rather than two copies that could drift.

What it cannot remove is trust in Wikipedia and in the connection to it. If the browser cannot do the check, the server
refetches, with two guards that matter: the address comes from the chain, never from the request, and only hosts on an
allowlist are contacted, with redirects followed by hand so that each hop is checked *before* it is requested. The contract
accepts any `http://` evidence URI, including `http://169.254.169.254/…`, so without the allowlist a poster could aim the
server at an internal address; there are tests for both the direct request and the redirect. The server path checks the quote
too, but cannot check the title. The operator command `npm run verify-evidence` uses the same allowlist and the same quote
check; it used to fetch every on-chain address without restriction, which on a cloud machine would have let evidence aim it at
the metadata service.

## Who settles the bonds

`settle_bond` is callable by anyone after the window, and the contract never calls it. Until this was noticed, nothing did: every
bond stayed open for ever and the agents' bonds stayed locked, so the refund-or-forfeit economics described above ran only in the
end-to-end test. The arbiter now runs a `BondKeeper` step on each pass (it scans evidence ids forward, remembers when each open
bond matures, and settles it; "already settled" and "window still open" from a slightly slow chain clock are expected and
handled). The keeper pays the gas, so it stops, once and out loud, when its balance falls below 0.1 NEAR. The server refetches an open bond every 10 s until its window has passed and every minute
after that, so a settlement shows on the page without another trade.

## Agents working at once

The end-to-end test runs agents one after another, which hid two failures that appear as soon as two agents share a claim.

- **The same source posted twice.** A researcher and a skeptic of one squad each checked "is there evidence yet?", each found
  none, and each posted. In one live run 15 of 24 distinct pieces of evidence were posted twice, each duplicate costing a fee
  and splitting the backing. Every agent in a process now shares one `ReviewLocks` by default; one that finds a claim already
  being reviewed passes over it (without losing a place in its per-pass quota), says so once a minute, and cites the evidence on
  a later pass. The lock lasts two minutes, but reading sources under a rate limit can take longer, so it is taken again just
  before the check-and-post, and an agent that has lost the claim posts nothing and does not mark it as checked.
- **Evidence posted, trade refused.** Evidence has to exist before a trade can cite it, so the agent posts first, and another
  agent moving the price in between makes the contract refuse the buy as slippage (19 refusals in that run). The evidence was
  then never cited and its bond was forfeited (14 of 37 settlements). The buy is now retried after looking at the price again;
  if the edge has gone, a small trade (0.025 NEAR, above the 0.02 bond) on the side the evidence argues for still backs it,
  because a 1% fee is cheaper than a forfeited bond. An agent that cannot afford both the evidence deposit and that trade does
  not post the evidence at all.

**What the measurements do and do not show.** An earlier version of this section credited the locks with a drop from 15 of 24
duplicates to 0 of 23. That was wrong: the locks existed but no demo or runner passed one in, so they were not active, and a
second run came out clean because transactions were fast enough that the agents rarely overlapped. The slippage retry was
active in that run (15 recoveries, none given up, 23 of 23 bonds refunded). The locks were then wired in and measured properly,
with a delay of 1.5 s added to every transaction so that agents really do overlap, two minutes each:

| | locks disabled (control) | locks on (default) |
|---|---|---|
| pieces of evidence posted twice | 4 of 23 | 0 of 23 |
| claims passed over as "being reviewed" | 0 | 22 |
| slippage retries | 20 | 0 |
| bonds forfeited | 0 | 0 |

That is one run of each, so it is suggestive, not statistical; what makes it convincing is that the control reproduces the race,
the treatment shows the locks excluding agents 22 times, and a unit test shows the same difference deterministically (two
analysts with separate locks both post, two with shared ones post once). Locks only cover agents in one process: agents in
separate processes can still race, and nothing on chain prevents a duplicate (the page merges them into one reference).

## Wikipedia's rate limit

Anonymous clients are limited, and a swarm of agents hits the limit in seconds (the first live run got HTTP 429 after a handful of claims). All real requests go through one limiter with a pause between them and backoff that honours `Retry-After`;
search and revision lookup are one API call; a pinned revision is cached on disk forever and a search for six hours; identical
in-flight searches are shared; and verdicts are cached by claim and content hash, which also stops a model judge being asked
the same question twice. `npm run warm` pre-fetches the demo's pages.

## What the swarm panel measures

Per agent: sources read, evidence posted (re-citing an existing source is not counted), trades, and profit, which is cash plus
positions minus where the account started. Positions are valued with `quote_sell`: what selling every share now would pay.
Valuing at spot overstated profit, because a 3 NEAR pool pays noticeably less than its price when you sell into it. Where the
agents' profit comes from I have not measured. My expectation is that it is mostly the creators' seed liquidity and anyone
trading the other side: an informed trader beats an AMM that started at 50%, and that is the subsidy that pays for the
information. A deeper seed would be a larger subsidy and a harder pool to push.

## What I have not verified

- Browser verification checks hash, title and quote, but the title check needs the Action API, so it exists only on the browser
  path. Other evidence hosts are verified by hash alone.
- A **language model** judging real Wikipedia has not been run (no API key). The rule-based judge has, against real pages. The
  model path (prompt, schema validation, quote check) is unit-tested with mocked replies only.
- The wallet path in the browser (`web/app.js`, wallet-selector from esm.sh) is untested. The demo path (server-held account)
  is the one that was exercised, in headless Chrome against a local node.
- The commands a deployment uses (`npm run bootstrap`, `npm run seed`, `npm run agents`, `npm run server`) were run once against testnet on 2026-11-08 and worked as written; the guided *lie* story was not played there (about 5 NEAR a play, and the testnet agents were out of NEAR), only the add-a-sentence story and direct injections. The load was the problem, not the code: see DEPLOY.md on rate limits and agent spending. The contract, agents and server also ran against `near-sandbox` (a real nearcore
  node), which is where every measurement here comes from. 1Click / NEAR Intents is not used; Verity does not need it, and I would rather not claim an integration that is not
  there.
- The rule-based judge was tuned on about fifty claims, most of them the demo's. It is not a benchmark and its behaviour on other
  topics is unmeasured.

### Limits of the demo account

The demo account is one wallet for every visitor. A picked lie always costs the same (2 NEAR seed, 2 NEAR pump), and the server refuses a demo action once the last hour's spending would pass `DEMO_HOURLY_BUDGET_NEAR` (default 150, about 29 plays of a lie). The arbiter's two legs are not atomic: if the second is refused after the first filled, the first stays open (a directional position, not a hedge); the agents' own caps bound the loss.

The visitor account starts with 400 NEAR and each agent with 200. No agent ever sells, so every lie it corrects leaves a few NEAR in a position it never closes; the funding, not any logic, is what lets the demo be replayed dozens of times (about 65 plays per squad at the cost estimated here, not measured). A demo action is refused with "out of funds" before it is sent when the visitor account is nearly empty.

### The browser wallet path

A wallet buy asks the server for a quote first and sends 95% of it as `min_shares`; a wallet sell does the same with `min_proceeds`, from `/api/position`. The wallet libraries are loaded from esm.sh at run time with their own versions pinned, but esm.sh resolves their dependencies when it is asked, and a dynamic import has no integrity check. For a page that asks people to sign transactions, bundle the libraries into `web/` before deploying; this is not done.

### The two demo stories

`seed/*.json` carries two kinds of demo sentence per article: `lies` (false, each naming the true claim it contradicts) and `adds` (true, contradicting nothing). A picked lie is opened at 80% and pumped with 2 NEAR so it enters at about 94%; a picked add is opened at 50% with a 1 NEAR pool and no pump, so the only thing that moves it is an agent that has read a source. The agents treat both the same way, which is the point: one pipeline, two outcomes. The adds were chosen by running the rule-based judge on candidates against live Wikipedia: four were confirmed (Charon 1978, Apollo 11 as the fifth crewed mission, Everest's Nepali name, Mars as the fourth planet) and one ("Neptune is the eighth planet from the Sun") was **wrongly refuted** by the judge, so it was not used. An add the judge cannot verify would sit at 50% and the story would time out. Against a contract seeded in an earlier run, the server finds the seed claims by topic and text (`resolveSeeds`); an edited seed claim stops matching, and a lie whose target is gone loses that target.

### What the server does for a stranger

`/api/quote`, `/api/claim-claims` and `/api/position` each make the node do work, so each visitor gets a burst of 40 requests per 10 seconds (counted by connection address, or by the proxy-appended `X-Forwarded-For` entry when `TRUST_PROXY=1`; see the last section). `/api/demo/me` is answered from a 1.5-second cache, since every open tab asks. Every response carries `nosniff`, `no-referrer` and `frame-ancestors 'self'`. There is no stricter content-security policy because the wallet path loads libraries from esm.sh and talks to wallet and RPC hosts that I have not been able to enumerate against a real wallet. The demo account is shared by every visitor, so the ledger and the story's "the lie cost you" are balance differences that another visitor's action also moves; the page says "(shared account)".

### When the language model does not answer

A language-model call that returns nothing usable (HTTP error, network error, an answer that is not the JSON asked for) is counted. The first one is printed to the console with its reason, `/api/config` reports the counts, and the header shows "(not answering)" when every call has failed. Each source an analyst gets no verdict on is an error line in its activity feed, so a wrong key looks like one rather than like a market with nothing to say. This has been tested against a faked endpoint; no real model has ever been called.

### Article spam and the proxy

Opening a claim under a new first topic segment makes a new article. It costs the opener about 0.57 NEAR (0.07 of it sunk), and every article costs the server node calls on each poll, so the server follows only the first 24 created, or exactly the list in `VERITY_ARTICLES`; later spam cannot displace the seeded articles, and a legitimate late article has to be named. Reading the topic list does not get slower with spam: see the gas row. The request limit counts by connection address unless `TRUST_PROXY=1`, when it counts by the last `X-Forwarded-For` entry; a proxy that does not set that header must not be trusted this way.

The agents follow the same articles as the server (`VERITY_ARTICLES` / `VERITY_MAX_ARTICLES`, shared code in `lib/scope.ts`): analysts leave other articles' claims alone, and the arbiter trades a link only when both its claims are in followed articles. Without that, two junk claims at 90% and a link between them (about 1.7 NEAR) would be a top-scoring contradiction that the arbiter keeps buying into every 15 seconds. The contract's accounting identity is also checked by a 4,000-step random walk that mixes every operation (buys citing evidence, sells, evidence posts including replacements on full claims, bond settlements, fee withdrawals, links).

Claims in an article the server does not follow still exist on the contract and can still be quoted, traded and (in a demo) injected into through the API; they are only not shown and not worked on. The server prints one warning at startup when it is hiding any.

### Things that grow with spam, and how each is read

Anyone can add topics, claims, links and evidence for a fraction of a NEAR, so nothing a client reads each cycle may cost more the longer those lists get. After measuring (see the gas row) these are the rules:

- **Topics, links, evidence** only ever get appended, so each is read once, in pages (200, 100, 100) that fit a view call, and afterwards only what was added since (`AppendIndex`). Callers that arrive while a read is under way share it: two reads starting together once appended the same page twice, after which the next read started past the end and skipped entries for good (a bug in the first version, found by reading it; a test now starts three at once). The server's link list used to be re-read from the start on every poll and stopped at 5,000; neither is true now. The bond keeper used to start at evidence 0 with one call per piece; it reads pages of 100 (`get_evidence_page`).
- **Agents' claims.** Reading every claim on the contract each cycle costs a page per 50 claims, tapes included, however many are junk. The agents now read claims page by page when that takes fewer calls than one per followed topic, and topic by topic otherwise (`createScope`), so the cost follows what they follow.
- **The server's polling.** Each poll reads the contract's counts (claims, evidence, links, total paid in and out), which change whenever anything is bought, sold, posted or opened, and re-reads the articles only when they have moved, or every 10 seconds regardless (a forfeited bond changes none of them). Measured on the demo at idle, counting the server's own node calls: 2.8 to 2.9 a second with the skip, 10.3 to 12.9 without it (`VERITY_FULL_REFRESH_MS=0`), about four times fewer; during activity it is back to the full rate, around 13. The load still grows with the number of followed topics (one claims call per topic on every full refresh), so a deployment with 24 busy articles should raise `VERITY_POLL_MS` or point the server at its own node.

### Verify and renamed pages

The browser compares the page title the API returns for a revision with the label on the source. The API returns the title the page has today, so a page renamed after an agent cited it looked like a wrong-page source. A title difference no longer decides: the server is asked to compare the raw page (hash and quote), and the answer says the title differs and why that may be harmless. A browser request that gets no answer within 20 seconds falls back to the server too.

### Two env files

The server reads the chain and shows the swarm panel; it never signs for the agents. DEPLOY therefore has the agents and the server read different env files (`DOTENV_CONFIG_PATH=.env.agents` and `.env.server`, see `.env.server.example`), so the agents' private keys are not in the environment of the public-facing process. The server also now loads `.env` before any module reads a setting: `sources.ts` takes `VERITY_USER_AGENT` and `VERITY_WIKI_GAP_MS` when it loads, and the server used to load `.env` only afterwards, so those two were ignored when set there (checked: with the fix the limiter sees the value from the file).

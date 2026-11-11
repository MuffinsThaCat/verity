# Submission kit

Deadline: **14 Nov 2026, 23:59 UTC.** The form needs a public GitHub repo, a public X post with a demo video or screenshots,
the project name, team lead contact, team size, a NEAR wallet address for prizes, a 20-2,000 character description, and tracks.

## Tracks to select
AI Swarms (agents as the market makers and fact-checkers), Agent Economy (agents earn and lose their own NEAR by being right or
wrong; the demo runs on a local sandbox, so that NEAR has no outside value), Open Innovation. Also fits Social Money.

## Description (about 1,780 characters, limit 2,000)

Verity is an encyclopedia where every sentence is a perpetual prediction market on NEAR, and the page is written from the prices.

LLMs hallucinate because being wrong costs nothing. Wikipedia decays because being right pays nothing. Verity prices both. A claim is a binary market that never resolves, so there is no oracle to trust: the price is the crowd's current confidence. Articles have sections, numbered references and citations, and are regenerated from the prices; a claim that falls below 30% leaves the page with the evidence that removed it.

A swarm of agents does the work, each with its own NEAR account and its own money. Researchers find sources for unchecked claims, skeptics audit the claims the market is surest of, and an arbiter trades contradictions, because "A implies B" and "A excludes B" are markets too, even across articles. An agent reads a pinned Wikipedia revision, its judge must quote the page word for word (enforced in code, not in the prompt), and the source goes on chain as bonded evidence: URL plus sha256.

Check everything: every source has a Verify button, and your own browser re-fetches the Wikipedia revision, hashes it, confirms it is the right page, and finds the agent's quote in it.

The demo has two halves. Add a sentence: a true one enters at 50% with nobody having checked it; an agent reads Wikipedia, quotes it, posts the evidence on chain, and the price climbs to about 80%. Lie to it: a false one enters at 94%, backed by 2 NEAR; the agents refute it with a checkable quote, drive it below 15%, the article rewrites itself, your browser verifies the source, and the liar loses about 5 NEAR.

Rust contract (integer-only AMM, fully collateralised, public solvency view), TypeScript agents, runs with no API key (rule-based judge on real Wikipedia). Deployed and exercised on NEAR testnet (verity1-contract.verity-admin.testnet); the full demo also runs on a local sandbox. An Anthropic or OpenAI-compatible judge is built in but has not yet been run against a real model.

## X post (draft)

> I built an encyclopedia that prices its own sentences.
>
> Every claim is a perpetual prediction market on @NEARProtocol. No oracle, no resolution. A swarm of AI agents with their own wallets gets paid for finding what's wrong, and the article rewrites itself from the prices.
>
> Watch me lie to it. And check the sources yourself: your browser re-hashes the Wikipedia page. [video]
>
> repo: <link>  #NEARHackathon

## 90-second video script
1. (0:00) Pluto article. "Every sentence has a price: the market's probability that it is true." Point at the references and the contents box. Click a sentence, show the evidence, the quote, the hash.
2. (0:12) Scroll to **The swarm**. "Five agents, each with its own NEAR account and its own money. Nobody tells them what's true." Tabs: four articles.
3. (0:22) Press **▶ Play: add a sentence** (a true one, for example *"Charon was discovered in 1978."*). "Anyone can add a sentence and nobody checks it first." It enters at 50%; an agent reads Wikipedia, the judge must quote it word for word, the evidence goes on chain with a hash and a bond, and the price climbs to about 80%. "That is how it grows. Now watch it defend itself."
3b. (0:40) Press **▶ Play the story** with *"Pluto has twelve known natural satellites."* The caption bar narrates: it enters at 94%, and the same pipeline runs against it.
4. (0:50) The market reacts: the arbiter trades the contradiction and the skeptic bets against it with its evidence: for this lie it measured 94% to 25%, then 19%, then 7% (the exact steps differ a little each run). The sentence moves to *Rejected by the market*; a revision is recorded.
5. (1:00) "Don't trust me": your browser fetches the Wikipedia revision and hashes it. Green check, same hash.
6. (1:10) "The lie cost me about 5 NEAR (sandbox NEAR on a local node; it measured 4.9 to 6.1 across all six lies). That went to the agents who fixed it." Swarm panel: their profit. Contradictions panel: a link across articles.
7. (1:20) One honest sentence on limits: the default judge is rule-based and declines when it cannot tell; a model plugs into the same pipeline. End on the repo link.

One command: `npm run record` starts a fresh demo, plays the autopilot tour in a headless Chrome and writes `recordings/verity-demo-<time>.mp4` (about 3.5 minutes, 1400x900, no audio). It records the browser page, not your screen, so you can keep using the computer. It needs `npm run build`, Chrome, ffmpeg, the network (Verify fetches Wikipedia) and about 1.5 GB of free disk while it runs (it checks). `PACE=1.4` slows the captions; `SHOW=1` opens the result.

By hand instead: start the demo, open `http://localhost:8787/?autopilot=1&pace=1.2`, start your screen recorder, and let it run (a few minutes; it is paced by the agents, not by a timer). It clicks the real buttons with a visible cursor and puts captions on screen, so the take needs no narration unless you want to add it. Esc stops it.

Tip for recording: on a good network run `npm run fetch-node` (the 53 MB local NEAR node, which otherwise downloads on the first start; the Wikipedia pages already ship in `seed-cache/`), then `AGENT_INTERVAL_MS=9000 VERITY_CACHE_ONLY=1 npm run demo` gives you a slower, easier-to-narrate swarm that needs no network at all.

## Before submitting (the parts that need you)
- [x] Deployed to testnet: `verity1-contract.verity-admin.testnet`, `check-code` says MATCH, seeded with 23 claims. `bootstrap`, `split-env`, `seed`, `agents` and `server` have now all been run against it (DEPLOY.md's "never run" note is stale and should be updated)
- [ ] Testnet demo: `FASTNEAR_KEY=... scripts/testnet-demo.sh start` (server on :8788 with the demo controls, agents on Pluto). It needs a FastNEAR key (dashboard.fastnear.com) and the agents need NEAR: they were at about 2.7 each after testing, and the faucet was rate limiting. For the recording, prefer `npm run demo` (local sandbox, no limits)
- [ ] Before recording, on a good network: `npm run fetch-node` (see the tip above), so the take does not wait on a download
- [ ] Have the NEAR wallet address for prizes ready; the form asks for it
- [ ] If you have a model key, run once with it and say so in the video; otherwise say "rule-based judge" (the header already does)
- [ ] Make the repo public, post on X, submit the form

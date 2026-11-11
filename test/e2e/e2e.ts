/**
 * End-to-end test on a real local NEAR chain (near-sandbox, a genuine nearcore node).
 *
 * Deploys the actual verity.wasm and runs the actual Analyst and Arbiter agents against it. The only simulated
 * pieces are the judge (an offline rule-based stand-in for the LLM) and the document set (a small static corpus).
 *
 *   npm run build:contract && npm run build && npm run e2e
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { Account, KeyPair } from "near-api-js";
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";

import { Chain } from "../../src/lib/chain.js";
import { Analyst, ReviewLocks } from "../../src/agents/analyst.js";
import { Arbiter } from "../../src/agents/arbiter.js";
import { BondKeeper } from "../../src/agents/keeper.js";
import { OfflineJudge } from "../../src/lib/offlineJudge.js";
import { StaticProvider, sha256Hex } from "../../src/lib/sources.js";
import { MemoryActivity, FileActivity } from "../../src/lib/activity.js";
import type { LieOption } from "../../src/demo/seeds.js";
import { buildArticle } from "../../src/article.js";
import { sleep } from "../../src/lib/log.js";
import { startServer } from "../../src/server.js";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { plutoCorpus, PLUTO_TOPIC, PLUTO_TRUE_CLAIMS, PLUTO_FALSE_CLAIM } from "../../src/demo/corpus.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const WASM = readFileSync(path.join(root, "contracts/verity/res/verity.wasm"));
const NEAR = 10n ** 24n;
const CLAIM_FEE = 70n * 10n ** 21n;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
/** Enough for any piece of evidence on these small claims: the contract's fee grows by an eighth for each already attached, and the rest is bond. */
const DEP = 5n * 10n ** 22n;

async function check(name: string, fn: () => Promise<void>) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ name, ok: false, detail });
    console.log(`  FAIL  ${name}\n        ${detail.split("\n").slice(0, 6).join("\n        ")}`);
  }
}

async function rejects(p: Promise<unknown>, pattern: RegExp) {
  try { await p; } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    assert.match(text, pattern, `rejected, but with the wrong reason: ${text.slice(0, 300)}`);
    return;
  }
  throw new Error(`expected a rejection matching ${pattern}, but the call succeeded`);
}

// near-sandbox caches its node binary here (and its ESM build needs the variable set). Reuse a sibling checkout's
// cache when there is one so a first run does not download it again.
if (!process.env.DIR_TO_DOWNLOAD_BINARY) {
  const sibling = path.join(root, "../1Hundo-near/.sandbox-bin");
  process.env.DIR_TO_DOWNLOAD_BINARY = existsSync(sibling) ? sibling : path.join(root, ".sandbox-bin");
}
const sandbox = await Sandbox.start({});
let exitCode = 1;

try {
  const rpc = sandbox.rpcUrl;
  console.log(`sandbox up at ${rpc}`);
  const rootAccount = new Account(DEFAULT_ACCOUNT_ID, rpc, DEFAULT_PRIVATE_KEY as `ed25519:${string}`);
  const keys = new Map<string, string>();
  async function mk(name: string, near: bigint): Promise<string> {
    const kp = KeyPair.fromRandom("ed25519");
    const id = `${name}.${DEFAULT_ACCOUNT_ID}`;
    await rootAccount.createAccount({ newAccountId: id, publicKey: kp.getPublicKey(), nearToTransfer: near });
    keys.set(id, kp.toString());
    return id;
  }
  const ids = {
    verity: await mk("verity", 30n * NEAR), editor: await mk("editor", 60n * NEAR), research: await mk("research", 40n * NEAR),
    skeptic: await mk("skeptic", 40n * NEAR), arbiter: await mk("arbiter", 40n * NEAR), saboteur: await mk("saboteur", 40n * NEAR),
    human: await mk("human", 20n * NEAR),
  };
  const chain = (id: string) => new Chain(id, keys.get(id), ids.verity, rpc);
  const C = Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, chain(v)])) as Record<keyof typeof ids, Chain>;

  await new Account(ids.verity, rpc, keys.get(ids.verity) as `ed25519:${string}`).deployContract(WASM);
  await C.verity.call("new", { bond_window_secs: 3, fee_bps: 100 });
  console.log("verity deployed");

  // The real server watches the chain from the start, so it records the revisions as the story unfolds.
  const actFile = path.join(tmpdir(), `verity-e2e-${Date.now()}.jsonl`);
  const lies: LieOption[] = [];
  const VERIFIED_TEXT = "the bytes of a pinned revision";
  const fetched: string[] = [];
  const verifyFetch = (async (url: string) => {
    fetched.push(String(url));
    return { ok: true, status: 200, url: String(url), headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode(VERIFIED_TEXT).buffer } as unknown as Response;
  }) as unknown as typeof fetch;
  const srv = startServer({
    port: 0, network: "sandbox", contractId: ids.verity, rpcUrl: rpc, activityFile: actFile,
    dataDir: path.join(tmpdir(), `verity-e2e-data-${Date.now()}`), llm: null, judgeLabel: "MOCK", sourcesLabel: "MOCK", mockCorpus: true,
    demo: { accountId: ids.human, privateKey: keys.get(ids.human)! }, pollMs: 400, lies, verifyFetch,
    agents: [
      { name: "researcher", role: "researcher", accountId: ids.research, startNear: 40 },
      { name: "skeptic", role: "skeptic", accountId: ids.skeptic, startNear: 40 },
      { name: "arbiter", role: "arbiter", accountId: ids.arbiter, startNear: 40 },
    ],
  });
  if (!srv.server.listening) await once(srv.server, "listening");
  const base = `http://127.0.0.1:${(srv.server.address() as AddressInfo).port}`;
  const get = async (p: string) => (await fetch(base + p)).json() as Promise<any>;
  const post = async (p: string, body: unknown) => { const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any }; };

  const claimIds: number[] = [];
  let falseId = -1;
  let linkClaim = -1;
  const mem = new MemoryActivity();
  const file = new FileActivity(actFile, false);
  const activity = { emit: (a: Parameters<MemoryActivity["emit"]>[0]) => { mem.emit(a); file.emit(a); } };

  await check("editor opens the true claims", async () => {
    for (const text of PLUTO_TRUE_CLAIMS) claimIds.push(Number(await C.editor.createClaim(PLUTO_TOPIC, text, 5000, CLAIM_FEE + 3n * NEAR)));
    const claims = await C.human.claimsByTopic(PLUTO_TOPIC);
    assert.equal(claims.length, 5);
    for (const c of claims) assert.ok(Math.abs(c.price_bps - 5000) <= 1);
    assert.deepEqual(await C.human.topics(), [PLUTO_TOPIC]);
  });

  let sabotBefore = 0n;
  await check("a saboteur injects a false claim and pumps it to ~95%", async () => {
    sabotBefore = await C.saboteur.balance();
    falseId = Number(await C.saboteur.createClaim(PLUTO_TOPIC, PLUTO_FALSE_CLAIM, 8000, CLAIM_FEE + 2n * NEAR));
    await C.saboteur.buy(falseId, "Yes", 2n * NEAR);
    const c = (await C.human.claim(falseId))!;
    assert.ok(c.price_bps > 9000, `price ${c.price_bps}`);
  });

  await check("a link market prices that the true and false satellite claims cannot both hold", async () => {
    linkClaim = Number(await C.editor.createLink(claimIds[1]!, falseId, "Excludes", 9000, CLAIM_FEE + 1n * NEAR));
    const v = await C.human.violations(5000, 100, 10);
    assert.equal(v.length, 1);
    assert.equal(v[0]!.link_claim, linkClaim);
    assert.ok(v[0]!.gap_bps > 4000, `gap ${v[0]!.gap_bps}`);
    await rejects(C.editor.createLink(claimIds[1]!, falseId, "Excludes", 9000, CLAIM_FEE + 1n * NEAR), /link already exists/);
    await rejects(C.editor.createLink(linkClaim, claimIds[0]!, "Implies", 9000, CLAIM_FEE + 1n * NEAR), /not other links/);
  });

  let gapBefore = 0;
  await check("the arbiter trades the inconsistency and the gap shrinks (it cannot tell which side is wrong)", async () => {
    gapBefore = (await C.human.violations(5000, 100, 10))[0]!.gap_bps;
    const arb = new Arbiter({ name: "arbiter", chain: C.arbiter, activity, maxLegNear: 1, cooldownMs: 0 });
    const legs = await arb.cycle();
    assert.equal(legs, 2);
    const after = await C.human.violations(0, 0, 10);
    const gapAfter = after[0]?.gap_bps ?? 0;
    assert.ok(gapAfter < gapBefore, `gap ${gapBefore} -> ${gapAfter}`);
  });

  const provider = new StaticProvider(plutoCorpus());
  const judge = new OfflineJudge();
  const mkAnalyst = (name: string, persona: "researcher" | "skeptic", c: Chain) =>
    new Analyst({ name, persona, chain: c, judge, sources: provider, activity, topics: [PLUTO_TOPIC], maxTradeNear: 2, maxClaimsPerCycle: 10, recheckAfterMs: 0, reserveNear: 2 });

  await check("the researcher posts evidence and buys YES on true claims, NO on the false one", async () => {
    const trades = await mkAnalyst("researcher", "researcher", C.research).cycle();
    assert.ok(trades >= 4, `only ${trades} trades`);
    const now = await C.human.claimsByTopic(PLUTO_TOPIC);
    const byId = new Map(now.map((c) => [c.id, c] as const));
    for (const id of claimIds.slice(0, 4)) assert.ok(byId.get(id)!.price_bps > 5000, `claim ${id} at ${byId.get(id)!.price_bps}`);
    assert.ok(byId.get(falseId)!.price_bps < 9000, `false claim still at ${byId.get(falseId)!.price_bps}`);
    const ev = await C.human.evidenceFor(falseId);
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.stance, "Refute");
    assert.match(ev[0]!.note, /five known natural satellites/);
    assert.equal(ev[0]!.author, ids.research);
  });

  await check("the skeptic reuses the researcher's evidence (no duplicates) and adds independent backing where the market lags", async () => {
    await mkAnalyst("skeptic", "skeptic", C.skeptic).cycle();
    await mkAnalyst("skeptic", "skeptic", C.skeptic).cycle();
    const ev = await C.human.evidenceFor(falseId);
    assert.equal(ev.length, 1, "same source and hash must be reused, not duplicated");
    let independent = 0n;
    for (const id of claimIds) for (const e of await C.human.evidenceFor(id)) {
      assert.equal(e.author, ids.research, `${e.uri} was duplicated by ${e.author}`);
      independent += BigInt(e.independent);
    }
    assert.ok(independent > 0n, "the skeptic's capital should show up as independent backing");
    const f = (await C.human.claim(falseId))!;
    assert.ok(f.price_bps < 3000, `false claim at ${f.price_bps}`);
  });

  await check("the false claim leaves the article body and the true ones stay", async () => {
    const claims = await C.human.claimsByTopic(PLUTO_TOPIC);
    const ev = new Map<number, Awaited<ReturnType<Chain["evidenceFor"]>>>();
    for (const c of claims) ev.set(c.id, await C.human.evidenceFor(c.id));
    const a = buildArticle(PLUTO_TOPIC, claims, ev);
    assert.ok(a.rejected.some((s) => s.claimId === falseId), "false claim should be rejected");
    assert.ok(a.body.length >= 4, `body has ${a.body.length}`);
    assert.ok(a.body.every((s) => s.claimId !== falseId));
  });

  await check("evidence bonds settle by whether trades cited them", async () => {
    await sleep(4000);
    const ev = await C.human.evidenceFor(falseId);
    const e = ev[0]!;
    assert.equal(await C.human.settleBond(e.id), "Refunded", "backed evidence gets its bond back");
    await rejects(C.human.settleBond(e.id), /already settled/);
    // evidence that nobody else backed is forfeited
    const lonely = Number(await C.research.postEvidence(claimIds[0]!, "Support", "https://example.org/lonely", "ab".repeat(32), "nobody follows", DEP));
    await sleep(4000);
    assert.equal(await C.human.settleBond(lonely), "Forfeited");
    assert.ok(BigInt((await C.human.claim(claimIds[0]!))!.fee_pool) >= 2n * 10n ** 22n);
  });

  await check("trading guards: slippage, holdings, stance mismatch", async () => {
    await rejects(C.human.sell(claimIds[0]!, "Yes", 10n ** 24n), /do not hold/);
    await rejects(C.human.buy(claimIds[0]!, "Yes", NEAR, 100n * NEAR), /slippage/);
    const ev = await C.human.evidenceFor(falseId);
    await rejects(C.human.buy(falseId, "Yes", NEAR, 0n, ev[0]!.id), /opposite stance/);
    await rejects(C.human.buy(claimIds[0]!, "Yes", 10n ** 21n), /minimum trade/);
  });

  await check("a human can trade, and the round trip costs only fees", async () => {
    const before = await C.human.balance();
    const shares = BigInt(await C.human.buy(claimIds[2]!, "Yes", NEAR));
    assert.ok(shares > 0n);
    const pos = await C.human.position(claimIds[2]!, ids.human);
    assert.equal(BigInt(pos.yes), shares);
    await C.human.sell(claimIds[2]!, "Yes", shares);
    const loss = before - (await C.human.balance());
    assert.ok(loss > 0n && loss < NEAR / 20n, `round trip cost ${Number(loss) / 1e24} NEAR`);
  });

  await check("lying cost the saboteur money", async () => {
    const pos = await C.saboteur.position(falseId, ids.saboteur);
    const shares = BigInt(pos.yes);
    if (shares > 0n) await C.saboteur.sell(falseId, "Yes", shares);
    const after = await C.saboteur.balance();
    const lost = sabotBefore - after;
    console.log(`        saboteur lost ${(Number(lost) / 1e24).toFixed(3)} NEAR`);
    assert.ok(lost > NEAR, `saboteur lost only ${Number(lost) / 1e24} NEAR`);
  });

  await check("only the creator collects fees", async () => {
    await rejects(C.human.withdrawFees(claimIds[0]!), /only the claim's creator/);
    const before = await C.editor.balance();
    const paid = BigInt(await C.editor.withdrawFees(claimIds[0]!));
    assert.ok(paid > 0n);
    assert.ok((await C.editor.balance()) > before - NEAR / 100n);
  });

  await check("the server recorded the story: the lie appeared, then left the article", async () => {
    await sleep(1500);
    const d = await get("/api/article?topic=pluto");
    assert.ok(d.article.rejected.some((x: any) => x.claimId === falseId));
    const kinds = d.revisions.flatMap((r: any) => r.changes.filter((c: any) => c.claimId === falseId).map((c: any) => c.kind));
    assert.ok(kinds.includes("added"), `kinds ${kinds}`);
    assert.ok(kinds.includes("removed-from-body"), `kinds ${kinds}`);
    assert.ok(d.violations.length >= 0 && d.links.length === 1);
    assert.equal(Object.keys(d.linkClaims).length, 1);
    const cfg = await get("/api/config");
    assert.equal(cfg.demo, true);
    assert.equal(cfg.chain.claims, 7);
  });

  await check("server demo controls: inject, quote, and readable errors", async () => {
    const q = await get(`/api/quote?claim=${claimIds[0]}&side=Yes&near=1`);
    assert.ok(BigInt(q.out) > 0n);
    assert.equal((await fetch(`${base}/api/quote?claim=x&side=Yes&near=1`)).status, 400);
    await sleep(3100);
    const bad = await post("/api/demo/inject", { topic: "Bad Topic", text: "A perfectly fine claim." });
    assert.equal(bad.status, 400);
    await sleep(3100);
    const ok = await post("/api/demo/inject", { topic: "pluto", text: "Pluto has seventeen moons, apparently.", pump_near: 0, seed_near: 1, contradicts: claimIds[1] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.claim.text, "Pluto has seventeen moons, apparently.");
    assert.ok(ok.body.linkClaim !== null);
    assert.equal(typeof ok.body.at, "number");
    const right = await get("/api/article?topic=pluto");
    assert.ok([...right.article.body, ...right.article.rejected].some((x: any) => x.claimId === ok.body.id), "a page read straight after the write already shows it");
    await sleep(3100);
    const err = await post("/api/demo/trade", { claim_id: 9999, side: "Yes", near: 0.5 });
    assert.equal(err.status, 500);
    assert.equal(err.body.error, "no such claim");
    await sleep(500);
    const d = await get("/api/article?topic=pluto");
    assert.ok([...d.article.body, ...d.article.rejected].some((x: any) => x.claimId === ok.body.id));
    const throttled = await post("/api/demo/trade", { claim_id: claimIds[0], side: "Yes", near: 0.5 });
    assert.ok(throttled.status === 429 || throttled.status === 200);
  });

  await check("the swarm panel reports each agent's work, positions and profit from the chain and the activity log", async () => {
    await sleep(4500);
    const rows = await get("/api/agents");
    assert.deepEqual(rows.map((r: any) => r.name).sort(), ["arbiter", "researcher", "skeptic"]);
    const by = Object.fromEntries(rows.map((r: any) => [r.name, r]));
    assert.ok(by.researcher.trades >= 4, `researcher trades ${by.researcher.trades}`);
    assert.ok(by.researcher.evidence >= 1 && by.researcher.reads >= 4, JSON.stringify(by.researcher));
    assert.ok(by.arbiter.trades >= 2, `arbiter trades ${by.arbiter.trades}`);
    for (const r of rows) {
      assert.equal(BigInt(r.equity), BigInt(r.balance) + BigInt(r.positions), `${r.name}: equity is cash plus positions`);
      assert.equal(BigInt(r.pnl), BigInt(r.equity) - BigInt(r.startEquity), `${r.name}: profit is equity less where it started`);
    }
    assert.ok(BigInt(by.researcher.positions) > 0n, "the researcher holds shares in the claims it bought");
    // The panel's figure must equal what selling every share the agent holds would pay, worked out here from the chain.
    for (const [name, c] of [["researcher", C.research], ["skeptic", C.skeptic], ["arbiter", C.arbiter]] as const) {
      let worth = 0n;
      for (const cl of await C.human.allClaims()) {
        const pos = await C.human.position(cl.id, c.accountId);
        for (const [side, key] of [["Yes", "yes"], ["No", "no"]] as const) {
          if (BigInt(pos[key]) >= 1_000_000_000_000n) worth += BigInt((await C.human.quoteSell(cl.id, side, BigInt(pos[key]))).out);
        }
      }
      assert.equal(BigInt(by[name].positions), worth, `${name}: positions are what selling them would pay`);
    }
    assert.ok(by.researcher.now && by.researcher.now.text.length > 0 && by.researcher.now.kind !== "scan");
    assert.equal(by.researcher.role, "researcher");
  });

  await check("evidence can be re-checked from the page: addresses come from the chain, only allowed hosts are fetched, mismatches are caught", async () => {
    const uri = "https://en.wikipedia.org/w/index.php?title=Pluto&oldid=424242&action=raw";
    const post = (u: string, hash: string, note = '"pinned revision"') => C.research.postEvidence(claimIds[2]!, "Support", u, hash, note, DEP).then(Number);
    const good = await post(uri, sha256Hex(VERIFIED_TEXT));
    const invented = await post(uri + "&y=2", sha256Hex(VERIFIED_TEXT), '"words the page never says"');
    const commentary = await post(uri + "&z=3", sha256Hex(VERIFIED_TEXT), "this page is the best overview of the topic");
    const wrong = await post(uri + "&x=1", "ab".repeat(32));
    const internal = await post("http://169.254.169.254/latest/meta-data", "cd".repeat(32));
    const g = await get(`/api/verify?evidence=${good}`);
    assert.equal(g.ok, true);
    assert.equal(g.actual, g.expected);
    assert.equal(g.quoteFound, true, "the quote the agent posted is in the page");
    const inv = await get(`/api/verify?evidence=${invented}`);
    assert.deepEqual([inv.ok, inv.quoteFound], [true, false], "a real hash does not make an invented quote real");
    const com = await get(`/api/verify?evidence=${commentary}`);
    assert.deepEqual([com.ok, com.quoteFound], [true, null], "commentary is not a quote, so it is not reported as a missing one");
    const w = await get(`/api/verify?evidence=${wrong}`);
    assert.equal(w.ok, false);
    assert.equal(w.actual, sha256Hex(VERIFIED_TEXT));
    const i = await get(`/api/verify?evidence=${internal}`);
    assert.equal(i.ok, null);
    assert.match(i.note, /host not allowed/);
    assert.ok(!fetched.some((u) => u.includes("169.254")), "an internal address is never contacted");
    const mock = (await C.human.evidenceFor(falseId))[0]!;
    const m = await get(`/api/verify?evidence=${mock.id}`);
    assert.equal(m.ok, null);
    assert.match(m.note, /offline test corpus/);
    const before = fetched.length;
    await get(`/api/verify?evidence=${good}`);
    assert.equal(fetched.length, before, "a verified result is remembered");
    assert.equal((await fetch(`${base}/api/verify?evidence=999999`)).status, 404);
    assert.equal((await fetch(`${base}/api/verify?evidence=abc`)).status, 400);
  });

  await check("a second article with sections, a lie from the picker, and contradictions that cross articles", async () => {
    const eight = Number(await C.editor.createClaim("solar-system", "The Solar System has eight planets.", 5000, CLAIM_FEE + 2n * NEAR));
    const charon = Number(await C.editor.createClaim("pluto/moons", "Charon is the largest moon of Pluto.", 5000, CLAIM_FEE + 2n * NEAR));
    await C.editor.createLink(claimIds[3]!, eight, "Implies", 9000, CLAIM_FEE + NEAR);
    lies.push({
      id: "solar-system:0", kind: "lie", article: "solar-system", topic: "solar-system", text: "The Solar System has nine planets.",
      contradicts: [{ id: eight, text: "The Solar System has eight planets." }, { id: claimIds[3]!, text: PLUTO_TRUE_CLAIMS[3]! }], note: "", priorBps: 8000,
    });
    assert.deepEqual((await get("/api/demo/lies")).map((l: any) => l.id), ["solar-system:0"]);
    await sleep(3100);
    assert.equal((await post("/api/demo/inject", { lie_id: "nope" })).status, 400);
    await sleep(3100);
    const r = await post("/api/demo/inject", { lie_id: "solar-system:0", seed_near: 1, pump_near: 1.5 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.linkClaims.length, 2);
    await sleep(1500);

    const topics = await get("/api/topics");
    assert.deepEqual(topics.map((t: any) => t.topic).sort(), ["pluto", "solar-system"]);
    const pl = await get("/api/article?topic=pluto");
    const moons = pl.article.sections.find((s: any) => s.key === "moons");
    assert.ok(moons && moons.body.some((x: any) => x.claimId === charon), "the sub-topic became a section");
    assert.equal(pl.article.sections[0].key, "", "the lead comes first");
    assert.ok(pl.article.references.length >= 1);
    for (const ref of pl.article.references) assert.ok(ref.n >= 1 && ref.claimIds.length >= 1 && ref.hash.length === 64);
    const cross = pl.violations.find((v: any) => v.a === claimIds[3] && v.b === r.body.id);
    assert.ok(cross, `no cross-article contradiction in ${JSON.stringify(pl.violations)}`);
    assert.equal(pl.others[r.body.id].text, "The Solar System has nine planets.", "the page can name the claim it conflicts with");
    assert.equal(pl.others[r.body.id].topic, "solar-system");
    const sol = await get("/api/article?topic=solar-system");
    assert.ok(sol.violations.length >= 2);
    assert.equal(sol.others[claimIds[3]!].topic, "pluto");
    const index = await get("/api/claims");
    assert.ok(index.some((c: any) => c.article === "solar-system") && index.some((c: any) => c.article === "pluto" && c.topic === "pluto/moons"));
    assert.ok(index.every((c: any) => typeof c.articleTitle === "string"));
    assert.equal((await get("/api/config")).agents, true);
  });

  await check("server hardening: bad JSON is a 400, the page cannot escape its directory, the shared text module is served, a settled bond shows as settled", async () => {
    const bad = await fetch(`${base}/api/demo/inject`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as any).error, /not valid JSON/);
    // fetch() normalises "/../" before sending, so send the paths as they are, over a raw socket.
    const raw = (p: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const port = (srv.server.address() as AddressInfo).port;
      const r = httpRequest({ host: "127.0.0.1", port, path: p, method: "GET" }, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b })); });
      r.on("error", reject); r.end();
    });
    for (const p of ["/..%2fpackage.json", "/..%2f..%2fpackage.json", "/%2e%2e/package.json", "/../package.json", "/%zz"]) {
      const r = await raw(p);
      assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
      assert.ok(!r.body.includes('"name": "verity"'), `${p} leaked a file outside the web directory`);
    }
    const mod = await fetch(`${base}/lib/wikitext.js`);
    assert.equal(mod.status, 200);
    assert.match(mod.headers.get("content-type") ?? "", /javascript/);
    const text = await mod.text();
    assert.ok(/export (const|function) cleanWikitext/.test(text));
    assert.ok(!text.includes("sourceMappingURL"), "no source-map comment pointing at a file the server does not serve");
    assert.ok(!/from\s+["']\.\//.test(text) && !text.includes("node:"), "the module the browser loads has no imports");
    // Two injects at once: one runs, the other is refused, and the account's nonce is never contended.
    await sleep(3100);
    const body = { topic: "pluto", text: "Pluto has a claim made only to test concurrency.", pump_near: 0, seed_near: 0.5 };
    const both = await Promise.all([post("/api/demo/inject", body), post("/api/demo/inject", body)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 429], JSON.stringify(both.map((r) => r.body)));
    assert.match(both.find((r) => r.status === 429)!.body.error, /another demo action|slow down/);
    // A step that fails after the claim exists is a warning beside a live claim, not an error that hides it.
    await sleep(3100);
    const partial = await post("/api/demo/inject", { topic: "pluto", text: "Pluto has a claim that cannot be linked anywhere.", contradicts: [999999], pump_near: 0, seed_near: 0.5 });
    assert.equal(partial.status, 200, JSON.stringify(partial.body));
    assert.equal(partial.body.linkClaims.length, 0);
    assert.match(partial.body.warnings[0], /could not link it to claim #999999: no such claim/);
    assert.equal((await C.human.claim(partial.body.id))!.text, "Pluto has a claim that cannot be linked anywhere.", "the claim is live");
    // Settling a bond changes neither the evidence count nor the trade count, so the server must refetch on its own.
    const d = await get("/api/article?topic=pluto");
    const all = Object.values(d.evidence).flat() as any[];
    assert.equal(all.find((e) => e.claim_id === falseId && e.author === ids.research)?.bond_state, "Refunded");
    assert.equal(all.find((e) => e.uri === "https://example.org/lonely")?.bond_state, "Forfeited");
  });

  await check("a keeper settles matured bonds; the arbiter does it as part of its pass", async () => {
    const post = (uri: string, note: string) => C.research.postEvidence(claimIds[4]!, "Support", uri, "ee".repeat(32), note, DEP).then(Number);
    const a = await post("https://example.org/keeper-a", '"never backed by anyone"');
    await sleep(4200);
    const keeper = new BondKeeper(C.arbiter, "keeper", activity);
    const n = await keeper.cycle();
    assert.ok(n >= 1, `settled ${n}`);
    const state = (await C.human.evidence(a))!.bond_state;
    assert.equal(state, "Forfeited", "nobody put money behind it, so the bond goes to the claim's fee pool");
    assert.equal(await keeper.cycle(), 0, "nothing left to settle, and settling twice is not attempted");
    assert.ok(mem.items.some((x) => x.kind === "settle" && x.agent === "keeper"));
    // the arbiter's own pass settles too
    const b = await post("https://example.org/keeper-b", '"also unbacked"');
    await sleep(4200);
    await new Arbiter({ name: "arbiter", chain: C.arbiter, activity, cooldownMs: 0 }).cycle();
    assert.equal((await C.human.evidence(b))!.bond_state, "Forfeited");
  });

  await check("agents working at once post a source once, not twice, and the swarm still ends up agreeing", async () => {
    const texts = ["Charon is the largest moon of Pluto.", "Pluto was visited by the New Horizons spacecraft in 2015."];
    const fresh: number[] = [];
    for (const text of texts) fresh.push(Number(await C.editor.createClaim("charon", text, 5000, CLAIM_FEE + 3n * NEAR)));
    const locks = new ReviewLocks();
    const mk2 = (name: string, persona: "researcher" | "skeptic", c: Chain) =>
      new Analyst({ name, persona, chain: c, judge, sources: provider, activity, topics: ["charon"], maxTradeNear: 1, maxClaimsPerCycle: 10, recheckAfterMs: 0, reserveNear: 2, locks });
    const r2 = mk2("researcher-2", "researcher", C.research), s2 = mk2("skeptic-2", "skeptic", C.skeptic);
    for (let round = 0; round < 3; round++) await Promise.all([r2.cycle(), s2.cycle()]);
    for (const id of fresh) {
      const evs = await C.human.evidenceFor(id);
      const keys = evs.map((e) => `${e.stance}:${e.content_hash}`);
      assert.ok(evs.length >= 1, `claim ${id} got no evidence`);
      assert.equal(new Set(keys).size, keys.length, `claim ${id}: the same source was posted twice: ${keys}`);
      assert.ok((await C.human.claim(id))!.price_bps > 5000, "and both true claims moved up");
    }
  });

  await check("a quote includes a new trader's first-trade fee, and a payout to a deleted account is stranded and accounted, not lost", async () => {
    const plain = BigInt((await C.human.quoteBuy(claimIds[0]!, "Yes", NEAR)).out);
    const newcomer = BigInt((await C.human.quoteBuy(claimIds[0]!, "Yes", NEAR, "nobody-has-traded.sandbox")).out);
    assert.ok(newcomer < plain, "the 0.002 NEAR position fee comes off a first trade");
    const holder = BigInt((await C.human.quoteBuy(claimIds[0]!, "Yes", NEAR, ids.research)).out); // the researcher has traded this claim
    assert.equal(holder, plain, "an account that already holds the claim pays no fee");

    const ghostId = await mk("ghost", 5n * NEAR);
    const ghost = chain(ghostId);
    const claim = claimIds[3]!;
    const evId = Number(await ghost.postEvidence(claim, "Support", "https://example.org/ghost", "ff".repeat(32), "left behind", DEP));
    await ghost.buy(claim, "Yes", NEAR / 2n, 0n, evId);
    const bond = BigInt((await C.human.evidence(evId))!.bond);
    await new Account(ghostId, rpc, keys.get(ghostId) as `ed25519:${string}`).deleteAccount(ids.human);
    await sleep(3500);
    const before = await C.human.accounting();
    assert.equal(await C.human.settleBond(evId), "Refunded", "the bond is owed to the author, who no longer exists");
    await sleep(3000);
    const after = await C.human.accounting();
    assert.equal(BigInt(after.stranded) - BigInt(before.stranded), bond, "the undelivered bond is reported as stranded");
    assert.equal(BigInt(after.total_in) - BigInt(after.total_out), BigInt(after.liabilities) + BigInt(after.kept), "and the accounting identity still holds");
    assert.ok(BigInt(after.kept) - BigInt(before.kept) >= bond, "it is kept, not paid out");
  });

  await check("the contract can prove its own solvency", async () => {
    const a = await C.human.accounting();
    assert.equal(BigInt(a.total_in) - BigInt(a.total_out), BigInt(a.liabilities) + BigInt(a.kept));
    const bal = await new Account(ids.verity, rpc).getBalance();
    assert.ok(bal >= BigInt(a.liabilities), `contract holds ${bal} but owes ${a.liabilities}`);
  });

  console.log("\nagent activity (first 12 lines):");
  for (const a of mem.items.filter((x) => x.kind === "trade" || x.kind === "evidence" || x.kind === "arb").slice(0, 12)) console.log(`  [${a.agent}] ${a.text}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error(e);
} finally {
  await sandbox.tearDown().catch(() => {});
  process.exit(exitCode);
}

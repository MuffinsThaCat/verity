// First, so that .env is in the environment before any module reads its settings (sources.ts reads VERITY_USER_AGENT and
// VERITY_WIKI_GAP_MS when it loads, and this file used to load .env only in its `main` block, after that).
import "dotenv/config";
import http from "node:http";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Chain, isRateLimited } from "./lib/chain.js";
import { redactSecrets } from "./lib/log.js";
import { ActivityTail } from "./lib/activity.js";
import { buildArticle, diffArticles, plainLede, writeLede, type Article, type Change, type LedeParagraph } from "./article.js";
import type { LLM } from "./lib/llm.js";
import type { ClaimView, Evidence, Link, Violation, VerityConfig, Accounting } from "./lib/types.js";
import { YOCTO_PER_NEAR } from "./lib/units.js";
import { Limiter, verifyEvidenceContent } from "./lib/sources.js";
import { articleOf, describeSource, prettyTopic } from "./lib/uri.js";
import { AppendIndex, selectArticles, TopicIndex } from "./lib/scope.js";
import { mapLimit } from "./lib/concurrency.js";
import { quotedText } from "./lib/wikitext.js";
import type { LieOption } from "./demo/seeds.js";

export interface AgentInfo {
  name: string;
  role: "researcher" | "skeptic" | "arbiter";
  accountId: string;
  /** Agents that work the same articles together. */
  squad?: string;
  /** What the account held when the run began, in NEAR; otherwise the first balance seen is used. */
  startNear?: number;
}

export interface ServerOpts {
  port: number;
  network: string;
  contractId: string;
  rpcUrl: string;
  activityFile: string;
  dataDir: string;
  llm: LLM | null;
  /** Shown in the UI so nobody mistakes a mock for a fact-checker. */
  judgeLabel: string;
  sourcesLabel: string;
  /** True when the evidence points into the built-in offline corpus (VERITY_MOCK=1); only then is it shown as test data. */
  mockCorpus?: boolean;
  /** Present only in a demo run: lets a visitor inject a false claim and place trades from one funded account. */
  demo?: { accountId: string; privateKey: string };
  /** The lies a visitor can pick in a demo run. */
  lies?: LieOption[];
  /** The agents to show on the swarm panel. */
  agents?: AgentInfo[];
  pollMs?: number;
  /** Articles to follow (first topic segments). Default: the first `maxArticles` created. */
  articles?: string[];
  maxArticles?: number;
  /** Read the client address from X-Forwarded-For (set only when a proxy you control sits in front). */
  trustProxy?: boolean;
  webDir?: string;
  /** Hosts the server will refetch to verify evidence (and their subdomains). Anything else is refused. */
  verifyHosts?: string[];
  /** For tests: the fetch used to verify evidence. */
  verifyFetch?: typeof fetch;
}

interface Revision {
  rev: number;
  ts: number;
  signature: string;
  changes: Change[];
  lede: LedeParagraph[];
  ledeBy: string;
  pending: boolean;
}

interface ArticleState {
  article: Article;
  revisions: Revision[];
  claims: ClaimView[];
  evidence: Record<number, Evidence[]>;
  violations: Violation[];
  links: Link[];
  linkClaims: Record<number, ClaimView>;
  /** Claims in other articles that this one is linked to, so the page can name them. */
  others: Record<number, ClaimView>;
  updated: number;
}

interface AgentRow {
  name: string;
  role: AgentInfo["role"];
  squad: string | null;
  account: string;
  balance: string;
  positions: string;
  equity: string;
  startEquity: string;
  pnl: string;
  reads: number;
  judged: number;
  evidence: number;
  trades: number;
  errors: number;
  lastAt: number | null;
  now: { kind: string; text: string; claimId: number | null; ts: number } | null;
  active: boolean;
}

export interface VerifyResult {
  id: number;
  uri: string;
  expected: string;
  actual: string | null;
  /** true: the content hashes to what was posted. false: it does not. null: it could not be checked. */
  ok: boolean | null;
  /** Whether the quote the agent posted is really in that page: true, false, or null when it could not be checked. */
  quoteFound: boolean | null;
  note: string | null;
  checkedAt: number;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};
const toYocto = (near: number) => BigInt(Math.round(near * 1e6)) * (YOCTO_PER_NEAR / 1_000_000n);
const CLAIM_FEE = toYocto(0.07);
const ACTIVE_MS = 9_000;

/** The contract's panic text, without the RPC wrapper around it. */
function cleanError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const m = /panic_msg: \\?"([^"\\]+)/.exec(text) ?? /Smart contract panicked: ([^\n]+)/.exec(text);
  return redactSecrets((m ? m[1]! : text.split("\n")[0]!).trim());
}

const httpError = (code: number, message: string) => Object.assign(new Error(message), { code });

/**
 * Who is asking. Behind a reverse proxy every request arrives from the proxy's own address, so counting by that address would
 * give the whole site one allowance. With `trustProxy`, the last entry of X-Forwarded-For (the one the proxy itself appended;
 * earlier entries are whatever the client claimed) is used instead.
 */
export function clientAddress(req: Pick<http.IncomingMessage, "headers" | "socket">, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    const last = (Array.isArray(fwd) ? fwd.join(",") : fwd ?? "").split(",").map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "?";
}

export { selectArticles } from "./lib/scope.js";

/** An RPC address with anything secret removed (a provider's api key rides in the query string, or as user:pass), for /api/config. */
export function publicUrl(u: string): string {
  try { const x = new URL(u); x.search = ""; x.hash = ""; x.username = ""; x.password = ""; return x.toString().replace(/\/$/, ""); } catch { return ""; }
}

/**
 * Opens a claim, and survives a provider's rate limit without sending it twice. A 429 can arrive after the transaction was
 * accepted, so a blind retry could open the same sentence a second time, and giving up would report a failure for something
 * that worked. After a rate-limit error, look for the claim (same topic, text and creator, made since `since`) and only send
 * again if it is not there.
 */
export async function createClaimOnce(
  c: Pick<Chain, "createClaim" | "claimsByTopic" | "accountId">,
  topic: string, text: string, prior: number, deposit: bigint, since: number,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      return Number(await c.createClaim(topic, text, prior, deposit));
    } catch (e) {
      if (!isRateLimited(e) || attempt >= 2) throw e;
      await wait(3000);
      const made = (await c.claimsByTopic(topic)).find((x) => x.text === text && x.creator === c.accountId && x.created_ms >= since - 15_000);
      if (made) return made.id;
    }
  }
}

export function startServer(o: ServerOpts) {
  const view = new Chain("view.invalid", undefined, o.contractId, o.rpcUrl);
  const demoChain = o.demo ? new Chain(o.demo.accountId, o.demo.privateKey, o.contractId, o.rpcUrl) : null;
  const webDir = o.webDir ?? path.resolve(here, "../../web");
  const revFile = path.join(o.dataDir, "revisions.json");
  const articles = new Map<string, ArticleState>();
  const tail = new ActivityTail(o.activityFile);
  const verifyHosts = o.verifyHosts ?? (process.env.VERITY_VERIFY_HOSTS?.split(",").map((s) => s.trim()).filter(Boolean) ?? ["wikipedia.org"]);
  const verifyLimiter = new Limiter(120);
  let meta: { config: VerityConfig | null; accounting: Accounting | null; ok: boolean; error: string | null; hiddenArticles?: number } = { config: null, accounting: null, ok: false, error: null };

  const saved: Record<string, Revision[]> = existsSync(revFile) ? (() => { try { return JSON.parse(readFileSync(revFile, "utf8")); } catch { return {}; } })() : {};

  // One write at a time, to a temporary file that is then renamed over the real one, so a crash or two overlapping writes
  // cannot leave half a file (which the loader would read as "no history").
  let persisting: Promise<void> = Promise.resolve();
  function persist(): Promise<void> {
    persisting = persisting.then(async () => {
      await mkdir(o.dataDir, { recursive: true });
      const out: Record<string, Revision[]> = {};
      for (const [t, s] of articles) out[t] = s.revisions.slice(-60);
      const tmp = `${revFile}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(out));
      await rename(tmp, revFile);
    }).catch(() => undefined);
    return persisting;
  }

  // Evidence is refetched when the claim's evidence list or trade count moved. Settling a bond changes neither, so while a
  // bond is open it is also refetched: every 10 s until its window (plus a little) has passed, then every minute, because
  // from then on it only changes when a keeper settles it.
  const evidenceCache = new Map<number, { key: string; at: number; list: Evidence[] }>();
  async function evidenceOf(c: ClaimView): Promise<Evidence[]> {
    const key = `${c.evidence.join(",")}:${c.trades}`;
    const hit = evidenceCache.get(c.id);
    if (hit && hit.key === key) {
      const open = hit.list.filter((e) => e.bond_state === "Open");
      const windowMs = meta.config?.bond_window_ms ?? 0;
      const every = open.length === 0 ? Infinity : open.some((e) => Date.now() < e.posted_ms + windowMs + 30_000) ? 10_000 : 60_000;
      if (Date.now() - hit.at < every) return hit.list;
    }
    const list = await view.evidenceFor(c.id);
    evidenceCache.set(c.id, { key, at: Date.now(), list });
    return list;
  }

  interface Shared {
    violations: Violation[];
    links: Link[];
    claimOf: (id: number) => Promise<ClaimView | null>;
  }

  async function refreshArticle(root: string, topics: string[], shared: Shared) {
    const claims = (await mapLimit(topics, 4, (t) => view.claimsByTopic(t))).flat();
    const withEv = claims.filter((c) => c.evidence.length > 0);
    const evLists = await mapLimit(withEv, 6, evidenceOf);
    const evidence: Record<number, Evidence[]> = {};
    withEv.forEach((c, i) => { evidence[c.id] = evLists[i]!; });
    const built = buildArticle(root, claims, new Map(Object.entries(evidence).map(([k, v]) => [Number(k), v] as const)), { mockCorpus: o.mockCorpus });
    const prev = articles.get(root);
    const revisions = prev?.revisions ?? saved[root] ?? [];
    const last = revisions[revisions.length - 1];

    const ids = new Set(claims.map((c) => c.id));
    const violations = shared.violations.filter((v) => ids.has(v.a) || ids.has(v.b));
    const links = shared.links.filter((l) => ids.has(l.a) || ids.has(l.b));
    const linkClaims: Record<number, ClaimView> = {};
    for (const l of links) { const c = await shared.claimOf(l.claim_id); if (c) linkClaims[c.id] = c; }
    const others: Record<number, ClaimView> = {};
    const wanted = new Set<number>();
    for (const l of links) { wanted.add(l.a); wanted.add(l.b); }
    for (const v of violations) { wanted.add(v.a); wanted.add(v.b); }
    for (const id of wanted) if (!ids.has(id)) { const c = await shared.claimOf(id); if (c) others[id] = c; }

    let lede = last?.lede ?? [];
    let ledeBy = last?.ledeBy ?? "";
    if (!last || last.signature !== built.signature) {
      const prevArticle = prev?.article ?? null;
      const changes = diffArticles(prevArticle, built);
      const rev: Revision = {
        rev: (last?.rev ?? 0) + 1, ts: Date.now(), signature: built.signature, changes,
        lede: plainLede(built.body), ledeBy: o.llm ? "market (rewriting)" : "market (no model)", pending: o.llm !== null,
      };
      revisions.push(rev);
      lede = rev.lede;
      ledeBy = rev.ledeBy;
      if (o.llm) {
        // Prices stay live while the model rewrites; the revision is patched in place when it is done.
        void writeLede(o.llm, built.body).then(({ lede: l, by }) => {
          rev.lede = l; rev.ledeBy = by; rev.pending = false;
          const st = articles.get(root);
          if (st && st.revisions[st.revisions.length - 1] === rev) st.article = { ...st.article, lede: l, ledeBy: by };
          void persist();
        }).catch(() => { rev.pending = false; rev.ledeBy = "market (model failed)"; });
      }
      void persist();
    }
    articles.set(root, { article: { ...built, lede, ledeBy }, revisions, claims, evidence, violations, links, linkClaims, others, updated: Date.now() });
  }

  // ───────────── swarm ─────────────

  const agentStart = new Map<string, bigint>();
  let agentRows: AgentRow[] = [];
  let agentsAt = 0;

  async function refreshAgents() {
    if (!o.agents?.length || Date.now() - agentsAt < 4_000) return;
    agentsAt = Date.now();
    tail.refresh();
    const tapeTouched = new Map<string, Set<number>>();
    for (const s of articles.values()) {
      for (const c of [...s.claims, ...Object.values(s.linkClaims), ...Object.values(s.others)]) {
        for (const t of c.tape) { let set = tapeTouched.get(t.who); if (!set) tapeTouched.set(t.who, (set = new Set())); set.add(c.id); }
      }
    }
    const rows: AgentRow[] = [];
    for (const a of o.agents) {
      const me = new Chain(a.accountId, undefined, o.contractId, o.rpcUrl);
      const counts = tail.agents.get(a.name);
      try {
        const balance = await me.balance();
        const touched = new Set<number>([...(counts?.tradedClaims ?? []), ...(tapeTouched.get(a.accountId) ?? [])]);
        // Positions are valued at what selling them now would pay, not at spot: a thin pool pays less than its price.
        let positions = 0n;
        await mapLimit([...touched], 6, async (id) => {
          const pos = await me.position(id, a.accountId);
          for (const [side, key] of [["Yes", "yes"], ["No", "no"]] as const) {
            const shares = BigInt(pos[key]);
            if (shares < 1_000_000_000_000n) continue;
            const worth = BigInt((await me.quoteSell(id, side, shares)).out);
            positions += worth; // read after the await: `positions += await ...` would lose concurrent updates
          }
        });
        const equity = balance + positions;
        if (!agentStart.has(a.name)) agentStart.set(a.name, a.startNear !== undefined ? toYocto(a.startNear) : equity);
        const start = agentStart.get(a.name)!;
        const real = counts?.lastReal ?? null;
        rows.push({
          name: a.name, role: a.role, squad: a.squad ?? null, account: a.accountId,
          balance: balance.toString(), positions: positions.toString(), equity: equity.toString(), startEquity: start.toString(), pnl: (equity - start).toString(),
          reads: counts?.reads ?? 0, judged: counts?.judged ?? 0, evidence: counts?.evidence ?? 0, trades: counts?.trades ?? 0, errors: counts?.errors ?? 0,
          lastAt: counts?.last?.ts ?? null,
          now: real ? { kind: real.kind, text: real.text, claimId: real.claimId ?? null, ts: real.ts } : null,
          active: !!counts?.last && Date.now() - counts.last.ts < ACTIVE_MS,
        });
      } catch {
        const prev = agentRows.find((r) => r.name === a.name);
        if (prev) rows.push(prev);
      }
    }
    agentRows = rows;
  }

  // ───────────── evidence verification ─────────────

  const verifyCache = new Map<number, VerifyResult>();
  const verifyRunning = new Map<number, Promise<VerifyResult>>();

  async function verifyEvidence(id: number): Promise<VerifyResult> {
    const cached = verifyCache.get(id);
    if (cached && Date.now() - cached.checkedAt < 5 * 60_000) return cached;
    const running = verifyRunning.get(id);
    if (running) return running;
    const p = (async (): Promise<VerifyResult> => {
      // The address comes from the chain, never from the request, and only an allowed host is ever fetched.
      const e = await view.evidence(id);
      if (!e) throw httpError(404, "no such evidence");
      const base = { id, uri: e.uri, expected: e.content_hash, checkedAt: Date.now() };
      if (describeSource(e.uri, { mockCorpus: o.mockCorpus }).mock) return { ...base, actual: null, ok: null, quoteFound: null, note: "This is the offline test corpus; there is nothing to fetch." };
      // The quote was taken from the page as wikitext reduced to text, so it can only be looked for in a raw Wikipedia revision.
      let host = "";
      try { host = new URL(e.uri).host; } catch { return { ...base, actual: null, ok: null, quoteFound: null, note: "the evidence address is not a valid URL" }; }
      const raw = /(^|\.)wikipedia\.org$/.test(host) && /[?&]action=raw\b/.test(e.uri);
      const quote = raw ? quotedText(e.note) : null;
      try {
        const r = await verifyEvidenceContent(e.uri, e.content_hash, quote, o.verifyFetch ?? fetch, { allowHosts: verifyHosts, limiter: verifyLimiter, retries: 2 });
        return { ...base, actual: r.actual, ok: r.ok, quoteFound: r.quoteFound, note: null };
      } catch (err) {
        return { ...base, actual: null, ok: null, quoteFound: null, note: err instanceof Error ? err.message.split("\n")[0]! : String(err) };
      }
    })().then((r) => { if (r.ok !== null) verifyCache.set(id, r); return r; }).finally(() => verifyRunning.delete(id));
    verifyRunning.set(id, p);
    return p;
  }

  // Links only ever get added, so they are read once and then only what is new (no ceiling on how many there can be).
  const linkIndex = new AppendIndex<Link>((from, limit) => view.links(from, limit), 100);
  // Nothing changes on the chain without moving one of these, apart from a bond being forfeited (which the full refresh below
  // catches), so a poll that finds them unchanged skips re-reading every article.
  const FULL_REFRESH_MS = Number(process.env.VERITY_FULL_REFRESH_MS ?? 10_000); // 0 re-reads every article on every poll
  let lastToken = "";
  let lastFull = 0;

  async function pollOnce(force = false) {
    try {
      const [config, accounting, list] = await Promise.all([view.config(), view.accounting(), topicIndex.refresh()]);
      // Merged, not replaced: a poll that skips the article refresh below must not wipe what the last full one recorded.
      meta = { ...meta, config, accounting, ok: true, error: meta.ok ? meta.error : null };
      const token = `${config.claims}|${config.evidence}|${config.links}|${accounting.total_in}|${accounting.total_out}`;
      if (!force && token === lastToken && articles.size > 0 && Date.now() - lastFull < FULL_REFRESH_MS) {
        await refreshAgents().catch(() => {});
        return;
      }
      meta.error = null;
      const [violations, links] = await Promise.all([view.violations(0, 1, 100, 3), linkIndex.refresh()]);
      const claimCache = new Map<number, Promise<ClaimView | null>>();
      const shared: Shared = { violations, links, claimOf: (id) => { let p = claimCache.get(id); if (!p) claimCache.set(id, (p = view.claim(id))); return p; } };
      const roots = new Map<string, string[]>();
      for (const t of list.filter((x) => x !== "meta:links")) { const r = articleOf(t); roots.set(r, [...(roots.get(r) ?? []), t]); }
      const shown = new Set(selectArticles([...roots.keys()], o.articles, o.maxArticles ?? 24));
      meta.hiddenArticles = roots.size - shown.size;
      if (meta.hiddenArticles > 0 && !warnedHidden) {
        warnedHidden = true;
        console.warn(`[verity] ${meta.hiddenArticles} article(s) on the contract are not followed: only ${o.articles?.length ? "the ones in VERITY_ARTICLES" : `the first ${o.maxArticles ?? 24} created`} are shown. Name a late article in VERITY_ARTICLES to add it.`);
      }
      for (const [root, topics] of roots) {
        if (!shown.has(root)) continue;
        try { await refreshArticle(root, topics, shared); } catch (e) { meta.error = `article ${root}: ${e instanceof Error ? e.message.split("\n")[0] : e}`; }
      }
      lastToken = token;
      lastFull = Date.now();
      await refreshAgents().catch(() => {});
    } catch (e) {
      meta = { ...meta, ok: false, error: e instanceof Error ? e.message.split("\n")[0]! : String(e) };
    }
  }

  // One poll at a time: on a slow RPC a poll can outlast the interval, and overlapping polls only multiply the load.
  let polling: Promise<void> | null = null;
  function poll(force = false): Promise<void> {
    if (!polling) polling = pollOnce(force).finally(() => { polling = null; });
    return polling;
  }
  /** A poll that starts after now: one already in flight may have read the chain before the caller's write. */
  async function pollFresh(): Promise<void> {
    if (polling) await polling;
    return poll(true);
  }

  // Endpoints that make the node do work for a stranger. A visitor gets a burst, then a steady rate; the page itself uses far less.
  const hits = new Map<string, { n: number; at: number }>();
  function throttle(req: http.IncomingMessage, limit = 40, windowMs = 10_000) {
    const who = clientAddress(req, o.trustProxy === true);
    const now = Date.now();
    if (hits.size > 5_000) for (const [k, v] of hits) if (now - v.at > windowMs) hits.delete(k);
    const h = hits.get(who);
    if (!h || now - h.at > windowMs) { hits.set(who, { n: 1, at: now }); return; }
    if (++h.n > limit) throw httpError(429, "too many requests; try again in a few seconds");
  }
  const topicIndex = new TopicIndex(view);
  let warnedHidden = false;
  let meCache: { at: number; body: { account: string; balance: string } } | null = null;

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  async function readBody(req: http.IncomingMessage, max = 20_000): Promise<any> {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) { n += (c as Buffer).length; if (n > max) throw httpError(413, "body too large"); chunks.push(c as Buffer); }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw httpError(400, "the request body is not valid JSON"); }
  }

  // One demo action at a time, and a pause after each: an inject is several transactions from one account, and two
  // visitors starting at once would collide on its nonce.
  let demoBusy = false;
  let demoLast = 0;
  // The demo account is one wallet for every visitor, so what it may spend in an hour is capped: a script posting to
  // /api/demo/* every few seconds could otherwise empty it in minutes. `cost` is the most the action can spend.
  const budgetNear = Number(process.env.DEMO_HOURLY_BUDGET_NEAR ?? 150);
  const spent: Array<{ at: number; near: number }> = [];
  async function demoAction<T>(costNear: number, fn: (c: Chain) => Promise<T>): Promise<T> {
    if (!demoChain) throw httpError(404, "demo controls are not enabled on this server");
    if (demoBusy) throw httpError(429, "another demo action is still running");
    if (Date.now() - demoLast < 3_000) throw httpError(429, "slow down: one demo action every few seconds");
    // Taken before anything is awaited, or two requests arriving together would both get past the check.
    demoBusy = true;
    try {
      // Say so plainly when the wallet itself is nearly empty, instead of letting a transaction fail with the node's wording.
      if ((await demoChain.balance()) < toYocto(costNear + 1)) throw httpError(503, "the demo account is out of funds; restart the demo");
      while (spent.length && Date.now() - spent[0]!.at > 3_600_000) spent.shift();
      if (spent.reduce((a, x) => a + x.near, 0) + costNear > budgetNear) throw httpError(429, "the demo's hourly spending limit is reached; try again later");
      spent.push({ at: Date.now(), near: costNear });
      return await fn(demoChain);
    } finally { demoBusy = false; demoLast = Date.now(); meCache = null; }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const p = url.pathname;
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("content-security-policy", "frame-ancestors 'self'");

      if (p === "/api/config") {
        return json(res, 200, {
          network: o.network, contractId: o.contractId, rpcUrl: publicUrl(o.rpcUrl), demo: !!demoChain, demoAccount: o.demo?.accountId ?? null,
          llm: o.llm?.name ?? null, llmHealth: o.llm?.health?.() ?? null, judge: o.judgeLabel, sources: o.sourcesLabel, mockCorpus: o.mockCorpus === true, ok: meta.ok, error: meta.error,
          chain: meta.config, accounting: meta.accounting, hiddenArticles: meta.hiddenArticles ?? 0, agents: (o.agents?.length ?? 0) > 0, lies: (o.lies?.length ?? 0) > 0,
        });
      }
      if (p === "/api/topics") {
        return json(res, 200, [...articles.entries()].map(([t, s]) => ({
          topic: t, title: s.article.title, claims: s.claims.filter((c) => c.link_id === null).length, rejected: s.article.rejected.length,
          sections: s.article.sections.length, revisions: s.revisions.length,
        })));
      }
      if (p === "/api/article") {
        const topic = url.searchParams.get("topic") ?? [...articles.keys()][0];
        const s = topic ? articles.get(topic) : undefined;
        if (!s) return json(res, 404, { error: "no such topic yet", topics: [...articles.keys()] });
        return json(res, 200, {
          article: s.article, revisions: s.revisions.slice(-30), violations: s.violations, evidence: s.evidence, updated: s.updated,
          claims: Object.fromEntries(s.claims.map((c) => [c.id, c])), links: s.links, linkClaims: s.linkClaims, others: s.others,
        });
      }
      if (p === "/api/claims") {
        return json(res, 200, [...articles.values()].flatMap((s) => s.claims.filter((c) => c.link_id === null).map((c) => ({
          id: c.id, topic: c.topic, article: articleOf(c.topic), articleTitle: s.article.title, text: c.text, price_bps: c.price_bps,
        }))));
      }
      if (p === "/api/claim-claims") {
        throttle(req);
        const ids = (url.searchParams.get("ids") ?? "").split(",").map(Number).filter(Number.isInteger).slice(0, 30);
        const out = (await mapLimit(ids, 6, (id) => view.claim(id))).filter(Boolean);
        return json(res, 200, out);
      }
      if (p === "/api/activity") {
        const since = Number(url.searchParams.get("since") ?? 0);
        tail.refresh();
        return json(res, 200, tail.recent.filter((a) => a.ts > since).slice(-300));
      }
      if (p === "/api/agents") {
        await refreshAgents().catch(() => {});
        return json(res, 200, agentRows);
      }
      if (p === "/api/verify") {
        const id = Number(url.searchParams.get("evidence"));
        if (!Number.isInteger(id) || id < 0) throw httpError(400, "bad evidence id");
        return json(res, 200, await verifyEvidence(id));
      }
      if (p === "/api/position") {
        throttle(req);
        // What an account holds in a claim and what selling it now would pay, so a wallet can sell with a floor on the proceeds.
        const id = Number(url.searchParams.get("claim"));
        const who = url.searchParams.get("account") ?? "";
        if (!Number.isInteger(id) || id < 0 || !/^[a-z0-9._-]{2,64}$/.test(who)) return json(res, 400, { error: "bad claim or account" });
        const pos = await view.position(id, who);
        const out: Record<string, { shares: string; out: string }> = {};
        for (const [side, key] of [["Yes", "yes"], ["No", "no"]] as const) {
          const shares = BigInt(pos[key]);
          out[side] = { shares: shares.toString(), out: shares >= 1_000_000_000_000n ? (await view.quoteSell(id, side, shares)).out : "0" };
        }
        return json(res, 200, out);
      }
      if (p === "/api/quote") {
        throttle(req);
        const id = Number(url.searchParams.get("claim"));
        const side = url.searchParams.get("side") === "No" ? "No" : "Yes";
        const near = Number(url.searchParams.get("near"));
        if (!Number.isInteger(id) || !(near > 0) || near > 1000) return json(res, 400, { error: "bad claim or amount" });
        // The account the quote is for: a wallet's, or the demo account. A first trade of a claim costs 0.002 NEAR more.
        const who = url.searchParams.get("account") ?? o.demo?.accountId;
        if (who !== undefined && !/^[a-z0-9._-]{2,64}$/.test(who)) return json(res, 400, { error: "bad account" });
        return json(res, 200, await view.quoteBuy(id, side, toYocto(near), who));
      }

      if (p === "/api/demo/lies") {
        if (!demoChain) return json(res, 404, { error: "demo controls are not enabled" });
        return json(res, 200, o.lies ?? []);
      }
      if (p === "/api/demo/inject" && req.method === "POST") {
        const b = await readBody(req);
        const lie = typeof b.lie_id === "string" ? (o.lies ?? []).find((l) => l.id === b.lie_id) : undefined;
        if (typeof b.lie_id === "string" && !lie) throw httpError(400, "unknown lie");
        const text = String(lie?.text ?? b.text ?? "").trim();
        let topic = String(lie?.topic ?? b.topic ?? "");
        if (!/^[a-z0-9_:/-]{1,64}$/.test(topic) || topic === "meta:links") throw httpError(400, "bad topic");
        if (text.length < 8 || text.length > 280) throw httpError(400, "claim must be 8-280 characters");
        const prior = Math.min(9000, Math.max(5000, Number(lie?.priorBps ?? b.prior_bps ?? 8000)));
        // A picked lie always costs the same; only a typed one may choose its amounts. A picked true sentence is opened at 50%
        // with a modest pool and no pump: it is a contribution, not an attack, and the agents are meant to be the ones who move it.
        const isAdd = lie?.kind === "add";
        const seed = lie ? (isAdd ? 1 : 2) : Math.min(5, Math.max(0.5, Number(b.seed_near ?? 2)));
        const pump = lie ? (isAdd ? 0 : 2) : Math.min(5, Math.max(0, Number(b.pump_near ?? 2)));
        if (![prior, seed, pump].every(Number.isFinite)) throw httpError(400, "prior_bps, seed_near and pump_near must be numbers");
        const raw = lie ? lie.contradicts.map((x) => x.id) : b.contradicts === null || b.contradicts === undefined || b.contradicts === "" ? [] : Array.isArray(b.contradicts) ? b.contradicts : [b.contradicts];
        const contradicts = raw.map(Number);
        if (contradicts.length > 3 || contradicts.some((x: number) => !Number.isInteger(x))) throw httpError(400, "bad contradicts id");
        // A topic holds 60 claims, and every replay of a lie opens one more. When the lie's section is nearly full the lie goes
        // to the article's lead instead; when that is full too, say so rather than let the contract refuse it.
        const inTopic = (t: string) => articles.get(articleOf(t))?.claims.filter((c) => c.topic === t).length ?? 0;
        if (inTopic(topic) >= 56) {
          const lead = articleOf(topic);
          if (inTopic(lead) >= 56) throw httpError(409, "this article has been replayed too many times to take another lie; restart the demo");
          topic = lead;
        }
        // A true sentence is a contribution, so adding one that is already there (a replayed story, a double click) must not open
        // a second copy: answer with the one that exists. Lies are different: replaying one is the point, and each play costs the same.
        if (isAdd || (!lie && pump === 0 && contradicts.length === 0)) {
          const have = (await view.claimsByTopic(topic)).find((c) => c.text === text);
          if (have) return json(res, 200, { id: have.id, linkClaim: null, linkClaims: [], enteredBps: have.price_bps, at: Date.now(), existing: true, warnings: ["this sentence is already in the article"], claim: have });
        }
        const out = await demoAction(seed + pump + 0.07 + 1.07 * contradicts.length, async (c) => {
          // The server's own clock, taken before the claim exists, so no agent event about it can predate it.
          const at = Date.now();
          const id = await createClaimOnce(c, topic, text, prior, CLAIM_FEE + toYocto(seed), at);
          // From here the claim is live. A step that fails (a full link table on the claim it contradicts, a pump that
          // cannot be paid for) is reported next to the claim that exists, not as a failure of the whole action.
          const warnings: string[] = [];
          if (pump > 0.012) {
            try { await c.buy(id, "Yes", toYocto(pump)); } catch (e) { warnings.push(`the pump failed (${cleanError(e)}), so the claim is at its opening price`); }
          }
          const entered = (await view.claim(id))?.price_bps ?? prior;
          const linkClaims: number[] = [];
          for (const target of contradicts) {
            try { linkClaims.push(Number(await c.createLink(target, id, "Excludes", 9000, CLAIM_FEE + toYocto(1)))); }
            catch (e) { warnings.push(`could not link it to claim #${target}: ${cleanError(e)}`); }
          }
          await pollFresh();
          return { id, linkClaim: linkClaims[0] ?? null, linkClaims, enteredBps: entered, at, warnings, claim: await view.claim(id) };
        });
        return json(res, 200, out);
      }
      if (p === "/api/demo/trade" && req.method === "POST") {
        const b = await readBody(req);
        const id = Number(b.claim_id);
        const side = b.side === "No" ? "No" : "Yes";
        const near = Math.min(5, Number(b.near));
        if (!Number.isInteger(id) || !(near >= 0.012)) throw httpError(400, "bad claim or amount");
        const evidence = b.evidence_id === null || b.evidence_id === undefined ? null : Number(b.evidence_id);
        const out = await demoAction(near, async (c) => {
          const shares = await c.buy(id, side, toYocto(near), 0n, evidence);
          await pollFresh();
          return { shares, claim: await view.claim(id) };
        });
        return json(res, 200, out);
      }
      if (p === "/api/demo/sell-all" && req.method === "POST") {
        const b = await readBody(req);
        const id = Number(b.claim_id);
        const out = await demoAction(0, async (c) => {
          const pos = await view.position(id, o.demo!.accountId);
          const paid: Record<string, string> = {};
          for (const [side, key] of [["Yes", "yes"], ["No", "no"]] as const) {
            const sh = BigInt(pos[key]);
            if (sh >= 1_000_000_000_000n) paid[side] = String(await c.sell(id, side, sh));
          }
          await pollFresh();
          return { paid, balance: String(await c.balance()) };
        });
        return json(res, 200, out);
      }
      if (p === "/api/demo/me") {
        if (!demoChain) return json(res, 404, { error: "demo controls are not enabled" });
        // Every open tab asks every couple of seconds; one balance read serves them all.
        if (!meCache || Date.now() - meCache.at > 1_500) meCache = { at: Date.now(), body: { account: o.demo!.accountId, balance: String(await demoChain.balance()) } };
        return json(res, 200, meCache.body);
      }

      // The pure text functions the agents use, served so the browser reduces a page to text the same way.
      if (p === "/lib/wikitext.js") {
        const data = await readFile(path.join(here, "lib/wikitext.js")).catch(() => null);
        if (!data) return json(res, 404, { error: "not found" });
        res.writeHead(200, { "content-type": MIME[".js"], "cache-control": "no-cache" });
        return res.end(data.toString("utf8").replace(/\n?\/\/# sourceMappingURL=.*\s*$/, "\n"));
      }

      // static files
      let rel: string;
      try { rel = decodeURIComponent(p === "/" ? "/index.html" : p); } catch { return json(res, 400, { error: "bad path" }); }
      const file = path.normalize(path.join(webDir, rel));
      if (file !== webDir && !file.startsWith(webDir + path.sep)) return json(res, 403, { error: "forbidden" });
      const data = await readFile(file).catch(() => null);
      if (!data) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(data);
    } catch (e) {
      const code = (e as { code?: number }).code;
      json(res, typeof code === "number" && code >= 400 && code < 600 ? code : 500, { error: cleanError(e) });
    }
  });

  server.listen(o.port);
  void poll();
  const timer = setInterval(() => void poll(), o.pollMs ?? 3000);
  return { server, poll, stop: () => { clearInterval(timer); server.close(); } };
}

// Run directly: `npm run server`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { NETWORK, RPC_URL, requireContract } = await import("./lib/config.js");
  const { makeLLM } = await import("./lib/llm.js");
  const llm = makeLLM();
  const demo = process.env.DEMO_ENABLED === "1" && process.env.DEMO_ACCOUNT_ID && process.env.DEMO_PRIVATE_KEY
    ? { accountId: process.env.DEMO_ACCOUNT_ID, privateKey: process.env.DEMO_PRIVATE_KEY } : undefined;
  const agents: AgentInfo[] = ([["RESEARCHER", "researcher"], ["SKEPTIC", "skeptic"], ["ARBITER", "arbiter"]] as const)
    .filter(([p]) => process.env[`${p}_ACCOUNT_ID`])
    .map(([p, role]) => ({ name: prettyTopic(role), role, accountId: process.env[`${p}_ACCOUNT_ID`]! }));
  const port = Number(process.env.PORT ?? 8787);
  // `npm run demo` seeds a chain it has just made and so knows every claim id. Against a contract that was seeded earlier
  // (testnet), find the seed claims on the chain by topic and text, so the lies and true sentences can still be offered.
  const lies: LieOption[] = [];
  if (demo) {
    try {
      const { loadSeedDir, resolveSeeds } = await import("./demo/seeds.js");
      const files = loadSeedDir(process.env.SEED_DIR ?? "seed");
      const onChain = await new Chain(demo.accountId, undefined, requireContract(), RPC_URL).allClaims();
      // Offer only what the agents will actually look at: a sentence in an article nobody follows would sit at its opening price
      // and the story would time out. The agents' own setting, AGENT_TOPICS, is the list (the launcher passes it to both).
      const followed = process.env.AGENT_TOPICS?.split(",").map((s) => articleOf(s.trim())).filter(Boolean) ?? [];
      lies.push(...resolveSeeds(files, onChain).filter((o) => !followed.length || followed.includes(o.article)));
    } catch (e) { console.warn(`[verity] could not offer the demo's lies and sentences: ${e instanceof Error ? e.message : String(e)}`); }
  }
  startServer({
    port, network: NETWORK, contractId: requireContract(), rpcUrl: RPC_URL, llm, demo, agents, lies,
    activityFile: process.env.ACTIVITY_LOG ?? "data/activity.jsonl", dataDir: process.env.DATA_DIR ?? "data",
    judgeLabel: llm ? `LLM (${llm.name})` : "rule-based judge (no model)", sourcesLabel: process.env.VERITY_SOURCES ?? "wikipedia",
    pollMs: Number(process.env.VERITY_POLL_MS ?? 3000), articles: process.env.VERITY_ARTICLES?.split(",").map((s) => s.trim()).filter(Boolean), maxArticles: Number(process.env.VERITY_MAX_ARTICLES ?? 24), trustProxy: process.env.TRUST_PROXY === "1",
  });
  console.log(`Verity UI on http://localhost:${port}  (${NETWORK}, contract ${requireContract()}, ${llm ? llm.name : "no LLM: plain ledes"})`);
}

// The text functions the agents use, loaded when a source is first checked. If they cannot be loaded (web files hosted
// apart from the server, say), the page still works and a check simply does not look for the quote.
let textTools;
async function loadTextTools() {
  if (textTools === undefined) textTools = await import("./lib/wikitext.js").catch(() => null);
  return textTools;
}

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const BANDS = [
  { min: 9000, key: "established", label: "Established" },
  { min: 7500, key: "likely", label: "Likely" },
  { min: 5500, key: "leaning-true", label: "Leaning true" },
  { min: 4500, key: "contested", label: "Contested" },
  { min: 2500, key: "leaning-false", label: "Leaning false" },
  { min: 1000, key: "doubtful", label: "Doubtful" },
  { min: 0, key: "refuted", label: "Refuted" },
];
const bandOf = (bps) => BANDS.find((b) => bps >= b.min);
const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;
const colour = (bps) => `hsl(${Math.round((bps / 10000) * 125)} ${dark() ? 62 : 64}% ${dark() ? 58 : 40}%)`;
const pct = (bps) => Math.round(bps / 100);
const near = (y, d = 2) => (Number(BigInt(y || "0") / 10n ** 18n) / 1e6).toFixed(d);
const nearNum = (y) => Number(BigInt(y || "0") / 10n ** 18n) / 1e6;
const short = (a) => (a.length > 22 ? a.slice(0, 10) + "…" + a.slice(-8) : a);
const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};
const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);
const safeHref = (u) => (/^https?:\/\//i.test(u) ? u : null);
const shq = (s) => String(s).replace(/'/g, "'\\''");
const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
// A pause in a story's narration. The autopilot sets window.verityPace (below 1 shortens the pauses, for a short recording);
// it never touches the waits that follow the chain, only how long a caption is left on screen.
const sleepMs = (ms) => waitMs(ms * (window.verityPace ?? 1));
const articleOf = (t) => String(t).split("/")[0];
const titleCase = (slug) => slug.split(/[-_:]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
const signed = (n, d = 2) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(d)}`;

let cfg = null;
let topic = null;
let topics = [];
let data = null;
let selected = null;
let panelSig = "";
let tabsSig = "";
let refsSig = "";
let lastRev = null;
let prices = new Map();
let seenBody = new Set();
let feedItems = [];
let feedSince = 0;
let baseline = null;
let walletReady = null;
let accountId = null;
let lastBodyHtml = "";
let hashApplied = false;
let lies = [];
let adds = [];
let claimIndex = [];
let claimIndexAt = 0;
let agents = [];
const equityHist = new Map();
const verified = new Map();
let PANEL_EMPTY = "";

async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status}`);
  return j;
}
const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

/** A demo write, waiting out the server's pause between demo actions instead of failing a click that came a moment early. */
async function demoPost(path, body) {
  for (let attempt = 0; ; attempt++) {
    try { return await post(path, body); }
    catch (e) {
      if (attempt >= 4 || !/slow down|another demo action/.test(e.message)) throw e;
      await waitMs(3200); // the server's own pause between demo actions: real time, never scaled
    }
  }
}

// ───────────────────────────── boot ─────────────────────────────

async function boot() {
  try { cfg = await api("api/config"); } catch (e) { return fail(`Cannot reach the Verity server: ${e.message}`); }
  PANEL_EMPTY = $("#panel").innerHTML;
  $("#pill-net").textContent = cfg.network;
  watchModel();
  const j = $("#pill-judge");
  j.textContent = cfg.judge;
  if (/MOCK|rule-based/i.test(cfg.judge)) { j.classList.add("mock"); j.title = "No language model is configured: a rule-based judge is evaluating evidence by keyword and number matching. It declines to trade when it cannot tell."; }
  $("#legend").innerHTML = BANDS.slice().reverse().map((b) => `<span><i style="background:${colour(b.min + 400)}"></i>${b.label}</span>`).join("");
  $("#footline").textContent = `Contract ${cfg.contractId} on ${cfg.network}. Sources: ${cfg.sources}.`;
  if (cfg.demo) {
    $("#demoCard").hidden = false;
    $("#demoWho").textContent = `You are ${cfg.demoAccount}.`;
    $("#injectForm").addEventListener("submit", injectCustom);
    $("#lieGo").addEventListener("click", injectPicked);
    $("#playStory").addEventListener("click", () => playStory("lie"));
    $("#playAdd").addEventListener("click", () => playStory("add"));
    $("#addGo").addEventListener("click", addPicked);
    $("#addForm").addEventListener("submit", addCustom);
    $("#stageStop").addEventListener("click", stopStory);
    loadLies();
  } else if (/^(testnet|mainnet)$/.test(cfg.network)) {
    $("#wallet").hidden = false;
    $("#wallet").addEventListener("click", walletToggle);
  }
  if (cfg.agents) { $("#swarmCard").hidden = false; swarmLoop(); }
  $("#verifyAll").addEventListener("click", verifyAll);
  loop();
  feedLoop();
}

/** If a language model is configured but not answering, say so in the header instead of leaving a quiet "LLM judge" label. */
function watchModel() {
  const h = cfg.llmHealth;
  const j = $("#pill-judge");
  if (h && h.failures > 0 && h.failures >= h.calls) { j.classList.add("mock"); j.title = `The language model is not answering: ${h.last ?? "no reason given"}. Agents are getting empty verdicts.`; j.textContent = `${cfg.judge} (not answering)`; }
  else if (cfg.llm && h) { j.classList.remove("mock"); j.textContent = cfg.judge; j.title = ""; }
  setTimeout(watchModel, 5000);
}

function fail(msg) {
  $("#title").textContent = "Verity is not reachable";
  $("#status").textContent = msg;
}

async function loop() {
  await refresh();
  setTimeout(loop, 2000);
}

let inflight = null;
let again = false;
function refresh() {
  if (inflight) { again = true; return inflight; }
  inflight = doRefresh().finally(() => { inflight = null; if (again) { again = false; refresh(); } });
  return inflight;
}

async function doRefresh() {
  try {
    cfg = { ...cfg, ...(await api("api/config")) };
    topics = await api("api/topics");
    if (!topic && topics.length) topic = topics[0].topic;
    renderTabs();
    if (!topic) {
      $("#status").textContent = cfg.ok ? "No articles yet. Open a claim on the contract to start one." : (cfg.error || "Connecting to the chain…");
      return setLive(cfg.ok);
    }
    data = await api(`api/article?topic=${encodeURIComponent(topic)}`);
    setLive(true);
    render();
    if (!hashApplied) {
      hashApplied = true;
      const m = /claim=(\d+)/.exec(location.hash);
      if (m) goToClaim(Number(m[1]));
    }
    if (cfg.demo) {
      demoLedger().catch(() => {});
      if (Date.now() - claimIndexAt > 6000) { claimIndexAt = Date.now(); claimIndex = await api("api/claims").catch(() => claimIndex); }
    }
  } catch (e) {
    setLive(false, e.message);
  }
}

function setLive(ok, msg) {
  const p = $("#pill-live");
  p.classList.toggle("ok", !!ok);
  p.classList.toggle("bad", !ok);
  $("span", p).textContent = ok ? "live" : (msg ? "offline" : "connecting");
  p.title = ok ? "Reading the chain every 2 seconds" : (msg || "");
}

async function switchArticle(t) {
  if (t === topic) return;
  topic = t;
  selected = null; panelSig = ""; refsSig = ""; prices = new Map(); seenBody = new Set(); lastRev = null; lastBodyHtml = "";
  $("#panel").innerHTML = PANEL_EMPTY;
  renderLieOptions();
  await refresh();
}

/** Open a claim anywhere in the encyclopedia, switching article first when it lives in another one. */
async function goToClaim(id) {
  if (data?.claims[id]) return select(id);
  let c = data?.others?.[id];
  if (!c) c = (await api(`api/claim-claims?ids=${id}`).catch(() => []))[0];
  if (!c) return;
  await switchArticle(articleOf(c.topic));
  select(id);
}

// ───────────────────────────── tabs ─────────────────────────────

function renderTabs() {
  const sig = JSON.stringify([topic, topics.map((t) => [t.topic, t.claims, t.rejected])]);
  if (sig === tabsSig) return;
  tabsSig = sig;
  $("#tabs").innerHTML = topics.map((t) =>
    `<button class="tab" role="tab" data-topic="${esc(t.topic)}" aria-controls="paper" aria-selected="${t.topic === topic}" tabindex="${t.topic === topic ? 0 : -1}"><span>${esc(t.title)}</span><small>${t.claims} claims${t.rejected ? ` · <b class="rj">${t.rejected} rejected</b>` : ""}</small></button>`).join("");
}

// ───────────────────────────── render ─────────────────────────────

function render() {
  const a = data.article;
  document.title = `${a.title} · Verity`;
  $("#kicker").textContent = "Market-priced article";
  $("#title").textContent = a.title;
  const rev = data.revisions[data.revisions.length - 1];
  $("#status").textContent = `${a.body.length} claims in the article, ${a.rejected.length} rejected · revision ${rev ? rev.rev : 1} · updated ${ago(data.updated)} ago`;
  renderInfobox(a, rev);

  const hasModelLede = !/^market/.test(a.ledeBy);
  $("#lede").hidden = !hasModelLede;
  $("#byline").hidden = !hasModelLede;
  $("#lede").innerHTML = a.lede.length
    ? a.lede.map((p) => `<p>${esc(p.text)} ${p.claimIds.map((i) => `<button class="ref" data-claim="${i}" aria-label="Open claim ${i}">[${i}]</button>`).join("")}</p>`).join("")
    : `<p class="muted">The market has not yet backed any claim strongly enough to summarise.</p>`;
  $("#byline").textContent = `Summary by ${a.ledeBy}. Every sentence in it cites the claims it states; a sentence with no backing claim is discarded.`;

  const titled = a.sections.filter((s) => s.key);
  const toc = $("#toc");
  toc.hidden = titled.length < 2;
  if (!toc.hidden) toc.innerHTML = `<b>Contents</b><ol>${titled.map((s) => `<li><a href="#${secId(s.key)}">${esc(s.title)}</a></li>`).join("")}${a.references.length ? `<li><a href="#references">References</a></li>` : ""}</ol>`;

  const body = $("#body");
  const bodyHtml = a.sections.map((sec) =>
    `${sec.key ? `<h2 class="sec" id="${secId(sec.key)}">${esc(sec.title)}</h2>` : ""}<p class="para">${sec.body.map(sentenceHtml).join(" ")}</p>`).join("");
  const bodyChanged = bodyHtml !== lastBodyHtml;
  if (bodyChanged) { body.innerHTML = bodyHtml; lastBodyHtml = bodyHtml; }
  for (const s of a.body) {
    const el = body.querySelector(`.sent[data-claim="${s.claimId}"]`);
    const was = prices.get(s.claimId);
    if (el && bodyChanged) {
      if (!seenBody.has(s.claimId) && seenBody.size) el.classList.add("enter");
      else if (was !== undefined && Math.abs(was - s.priceBps) >= 100) el.classList.add(s.priceBps > was ? "flash-up" : "flash-down");
    }
    prices.set(s.claimId, s.priceBps);
    seenBody.add(s.claimId);
  }
  if (selected !== null) body.querySelector(`.sent[data-claim="${selected}"]`)?.classList.add("sel");

  const rej = a.rejected;
  $("#rejectedWrap").hidden = rej.length === 0;
  $("#rejected").innerHTML = rej.map((s) => `<li data-claim="${s.claimId}" tabindex="0" role="button"><s>${esc(s.text)}</s>${s.refs.length ? `<span class="rm">removed on evidence ${s.refs.map((r) => `[${r.n}]`).join("")}</span>` : ""}<b>${pct(s.priceBps)}%</b></li>`).join("");
  for (const s of rej) prices.set(s.claimId, s.priceBps);

  renderRefs();
  renderRevisions();
  renderViolations();
  renderDemoOptions();
  if (selected !== null) renderPanel();
}

const secId = (key) => `sec-${key.replace(/[^a-z0-9_-]/gi, "-")}`;

function renderInfobox(a, rev) {
  const box = $("#infobox");
  box.hidden = a.body.length + a.rejected.length === 0;
  if (box.hidden) return;
  const n = a.body.length || 1;
  const counts = BANDS.map((b) => ({ b, c: a.body.filter((s) => bandOf(s.priceBps).key === b.key).length })).filter((x) => x.c > 0);
  const strong = a.body.filter((s) => s.priceBps >= 7500).length;
  const open = a.body.filter((s) => s.priceBps < 7500).length;
  box.innerHTML = `<h3>At a glance</h3>
    <div class="ib-bar" role="img" aria-label="Claims by confidence">${counts.slice().reverse().map((x) => `<i style="width:${(x.c / n) * 100}%;background:${colour(x.b.min + 400)}" title="${x.c} ${x.b.label.toLowerCase()}"></i>`).join("")}</div>
    <dl><dt>In the article</dt><dd>${a.body.length}</dd><dt>Well established</dt><dd>${strong}</dd><dt>Still open</dt><dd>${open}</dd><dt>Rejected</dt><dd>${a.rejected.length}</dd><dt>Sources</dt><dd>${a.references.length}</dd><dt>Revisions</dt><dd>${rev ? rev.rev : 1}</dd></dl>`;
}

function citesHtml(refs) {
  if (!refs.length) return "";
  return `<sup class="cites">${refs.map((r) => `<a href="#ref-${r.n}" class="cite ${r.stance}" data-ref="${r.n}" title="${r.stance === "Support" ? "Supported" : "Refuted"} by source ${r.n}">[${r.n}]</a>`).join("")}</sup>`;
}

function sentenceHtml(s) {
  const c = colour(s.priceBps);
  return `<span class="sent band-${s.band}" data-claim="${s.claimId}" tabindex="0" role="button" style="--c:${c}" title="${esc(s.label)}: ${pct(s.priceBps)}%. Click for the market."><span class="txt">${esc(s.text)}</span><span class="chip" style="--c:${c}"><i></i>${pct(s.priceBps)}%</span></span>${citesHtml(s.refs)}`;
}

function gotoRef(n) {
  const el = document.getElementById(`ref-${n}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

// ───────────────────────────── references and verification ─────────────────────────────

function srcInfo(uri) {
  try {
    const u = new URL(uri);
    const mock = cfg?.mockCorpus === true && u.host === "mock-corpus.invalid";
    const wiki = /(^|\.)wikipedia\.org$/.test(u.host);
    const title = u.searchParams.get("title")?.replace(/_/g, " ");
    const oldid = u.searchParams.get("oldid");
    if (mock) { const t = decodeURIComponent(u.pathname.split("/").pop() || ""); return { label: `${t} (offline test corpus)`, mock: true, href: null, host: u.host, wiki: null }; }
    if (wiki && title) {
      const h = new URL(u.toString()); h.searchParams.delete("action");
      return { label: `${title} (Wikipedia${oldid ? `, revision ${oldid}` : ""})`, mock: false, href: safeHref(h.toString()), host: u.host, title, wiki: oldid && /^\d+$/.test(oldid) ? { host: u.host, oldid } : null };
    }
    return { label: u.host, mock: false, href: safeHref(u.toString()), host: u.host, wiki: null };
  } catch { return { label: uri, mock: false, href: null, host: uri, wiki: null }; }
}

const vkey = (uri, hash) => `${uri}\n${hash}`;

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function setVerified(key, status, text) {
  const st = { status, text };
  verified.set(key, st);
  refsSig = ""; panelSig = "";
  if (data) { renderRefs(); if (selected !== null) renderPanel(); }
  return st;
}

const sameTitle = (a, b) => String(a).replace(/_/g, " ").trim().toLowerCase() === String(b).replace(/_/g, " ").trim().toLowerCase();

/**
 * Check a source against what is on chain. The reader's browser does it when it can (Wikipedia's API allows cross-origin
 * reads, and the wikitext it returns hashes to the same value as the raw page the agents fetched). It checks three things:
 * the hash, that the revision belongs to the page the source is labelled as, and that the quote the agent posted is really
 * in the page (reduced to text by the very code the agents ran). What it cannot remove is trust in Wikipedia and in the
 * connection to it. Otherwise the server refetches, but only from an allowed host.
 */
async function verify(uri, hash, evidenceId, note) {
  const key = vkey(uri, hash);
  setVerified(key, "busy", "fetching the revision…");
  const info = srcInfo(uri);
  let titleNote = "";
  if (info.wiki) {
    try {
      const apiUrl = `https://${info.wiki.host}/w/api.php?action=query&prop=revisions&revids=${info.wiki.oldid}&rvprop=content&rvslots=main&format=json&formatversion=2&origin=*`;
      // A request that never answers must not leave the row on "fetching…" for ever: give up and let the server check it.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20000);
      const j = await fetch(apiUrl, { signal: ctl.signal }).then((r) => r.json()).finally(() => clearTimeout(timer));
      const page = j.query.pages[0];
      const content = page.revisions[0].slots.main.content;
      const digest = await sha256Hex(new TextEncoder().encode(content));
      if (digest !== hash) {
        setVerified(key, "busy", "your browser's copy hashed differently; asking the server to compare the raw page…");
      } else if (info.title && !sameTitle(page.title, info.title)) {
        // The API gives the page's title today. A page renamed since the agent cited it looks exactly like this, so it is not called
        // bad on this alone: the server is asked (hash and quote), and the difference is reported either way.
        titleNote = ` The revision now belongs to the page “${page.title}”, not “${info.title}” as this source is labelled: it may have been renamed since, or the label may be wrong.`;
        setVerified(key, "busy", "the page title differs from the label; asking the server to compare the raw page…");
      } else {
        const tools = await loadTextTools();
        const quote = tools && note ? tools.quotedText(note) : null;
        const quoteOk = quote ? tools.quoteIsInSource(quote, tools.cleanWikitext(content)) : null;
        if (quoteOk === false) return setVerified(key, "bad", `✗ The hash matches, but the quoted text is NOT in that page. The agent's quote cannot be trusted.`);
        const note2 = quoteOk ? ", and the quoted text is in it word for word" : !tools && note ? " (the quote was not checked: the text module could not be loaded)" : "";
        return setVerified(key, "ok", `✓ Verified in your browser: revision ${info.wiki.oldid} of “${page.title}” hashes to ${hash.slice(0, 12)}…, exactly what was posted${note2}. You are still trusting Wikipedia and your connection to it.`);
      }
    } catch {
      setVerified(key, "busy", "the browser could not fetch it; asking the server…");
    }
  }
  try {
    const r = await api(`api/verify?evidence=${evidenceId}`);
    if (r.ok === true && r.quoteFound === false) setVerified(key, "bad", "✗ The page hashes correctly, but the quoted text is NOT in it. The agent's quote cannot be trusted.");
    else if (r.ok === true) setVerified(key, "ok", `✓ Verified by the server: the page it fetched hashes to the recorded value${r.quoteFound ? " and contains the quote" : ""}.${titleNote || " (The page title was not checked on this path.)"}`);
    else if (r.ok === false) setVerified(key, "bad", `✗ MISMATCH. The page now hashes to ${r.actual.slice(0, 12)}…, not ${r.expected.slice(0, 12)}…`);
    else setVerified(key, "na", r.note || "this source cannot be checked");
  } catch (e) { setVerified(key, "na", e.message); }
  return verified.get(key);
}

function verifyBlock(uri, hash, evidenceId, note) {
  const st = verified.get(vkey(uri, hash));
  const busy = st?.status === "busy";
  return `<button class="vbtn" data-verify data-uri="${esc(uri)}" data-hash="${esc(hash)}" data-eid="${evidenceId}" data-note="${esc(note ?? "")}" ${busy ? "disabled" : ""}>${st && !busy ? "Verify again" : "Verify"}</button>${st ? `<span class="vres ${st.status}">${esc(st.text)}</span>` : ""}`;
}

async function verifyAll() {
  const refs = data?.article.references ?? [];
  for (const r of refs) {
    if (r.mock || verified.get(vkey(r.uri, r.hash))?.status === "ok") continue;
    await verify(r.uri, r.hash, r.evidenceIds[0], r.note);
  }
}

function renderRefs() {
  const refs = data.article.references;
  $("#refsWrap").hidden = refs.length === 0;
  const sig = JSON.stringify([refs.map((r) => [r.n, r.backing, r.claimIds, r.stance]), refs.map((r) => verified.get(vkey(r.uri, r.hash)))]);
  if (sig === refsSig) return;
  refsSig = sig;
  $("#refs").innerHTML = refs.map((r) => {
    const info = srcInfo(r.uri);
    const where = info.href ? `<a href="${esc(info.href)}" target="_blank" rel="noopener noreferrer">${esc(r.label)}</a>` : `<span>${esc(r.label)}</span>`;
    const stance = r.stance === "Mixed" ? "Mixed" : r.stance;
    return `<li class="ref-item" id="ref-${r.n}" data-n="${r.n}">
      <div class="ref-head1"><span class="stance ${r.stance === "Refute" ? "Refute" : "Support"}">${stance === "Support" ? "Supports" : stance === "Refute" ? "Refutes" : "Cited both ways"}</span>${where}</div>
      ${r.quote ? (r.isQuote ? `<blockquote>“${esc(r.quote)}”</blockquote>` : `<p class="muted">Note: ${esc(r.quote)}</p>`) : ""}
      <div class="ref-meta"><span class="ref-claims">cited for ${r.claimIds.map((id) => `<button data-claim="${id}">#${id}</button>`).join(" ")}</span><span title="${esc(r.hash)}">sha256 <code>${esc(r.hash.slice(0, 12))}…</code></span><span>${near(r.backing, 2)} NEAR behind it</span>${r.mock ? `<span>offline test corpus: nothing to fetch</span>` : verifyBlock(r.uri, r.hash, r.evidenceIds[0], r.note)}</div>
    </li>`;
  }).join("");
}

// ───────────────────────────── revisions, contradictions ─────────────────────────────

function renderRevisions() {
  const revs = data.revisions.slice().reverse();
  $("#revs").innerHTML = revs.map((r) => {
    const lines = r.changes.length
      ? r.changes.map((c) => `<div class="chg">${changeText(c)}</div>`).join("")
      : `<div class="chg muted">${r.rev === 1 ? "First version, written from the opening prices." : "No sentence changed band."}</div>`;
    return `<li><span class="rn">Rev ${r.rev}</span><span class="when">${clock(r.ts)}</span>${lines}</li>`;
  }).join("");
  const latest = data.revisions[data.revisions.length - 1];
  if (latest) {
    if (lastRev !== null && latest.rev > lastRev) {
      for (const r of data.revisions.filter((x) => x.rev > lastRev)) for (const c of r.changes.slice(0, 2)) toast(changeText(c, true));
    }
    lastRev = latest.rev;
  }
}

function changeText(c, plain) {
  const t = `“${esc(c.text.length > 70 ? c.text.slice(0, 67) + "…" : c.text)}”`;
  const from = c.fromBps === null ? null : pct(c.fromBps);
  const to = pct(c.toBps);
  const cls = from !== null && to < from ? "down" : "up";
  const arrow = from === null ? `${to}%` : `<span class="${plain ? "" : cls}">${from}% → ${to}%</span>`;
  switch (c.kind) {
    case "added": return `<b>New claim</b> ${t} enters at ${to}%.`;
    case "removed-from-body": return `<b>Removed from the article:</b> ${t} ${arrow}.`;
    case "restored-to-body": return `<b>Back in the article:</b> ${t} ${arrow}.`;
    default: return `${t} moved ${arrow} (${esc(c.fromBand)} → ${esc(c.toBand)}).`;
  }
}

const claimOf = (id) => data.claims[id] ?? data.others?.[id];

function renderViolations() {
  const v = data.violations;
  const ul = $("#viol");
  ul.classList.toggle("empty", v.length === 0);
  if (!v.length) { ul.innerHTML = `<li>No contradiction is priced right now. Every linked pair is consistent.</li>`; return; }
  const text = (id) => {
    const c = claimOf(id);
    if (!c) return `#${id}`;
    const t = c.text.length > 60 ? c.text.slice(0, 57) + "…" : c.text;
    return esc(t) + (articleOf(c.topic) !== topic ? ` <span class="muted">(in ${esc(titleCase(articleOf(c.topic)))})</span>` : "");
  };
  ul.innerHTML = v.map((x) => `<li data-claim="${x.a}" tabindex="0" role="button">
      ${x.rel === "Implies" ? `“${text(x.a)}” implies “${text(x.b)}”` : `“${text(x.a)}” and “${text(x.b)}” cannot both be true`}<br>
      priced ${pct(x.price_a_bps)}% and ${pct(x.price_b_bps)}% — <span class="gap">${pct(x.gap_bps)} ${pct(x.gap_bps) === 1 ? "point" : "points"} out of line</span>, and the market is ${pct(x.link_conf_bps)}% sure the relation holds.</li>`).join("");
}

// ───────────────────────────── panel ─────────────────────────────

function spark(points) {
  const w = 300, h = 64, pad = 4;
  const ps = points.length >= 2 ? points : [points[0] ?? 5000, points[0] ?? 5000];
  const x = (i) => pad + (i * (w - 2 * pad)) / (ps.length - 1);
  const y = (p) => h - pad - (p / 10000) * (h - 2 * pad);
  const d = ps.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  const last = ps[ps.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Price history">
    <line x1="0" x2="${w}" y1="${y(5000)}" y2="${y(5000)}" stroke="var(--line)" stroke-dasharray="3 4"/>
    <path d="${d}" fill="none" stroke="${colour(last)}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${x(ps.length - 1)}" cy="${y(last)}" r="3.5" fill="${colour(last)}"/></svg>`;
}

function select(id) {
  selected = id;
  panelSig = "";
  document.querySelectorAll(".sent.sel").forEach((e) => e.classList.remove("sel"));
  document.querySelector(`#body .sent[data-claim="${id}"]`)?.classList.add("sel");
  renderPanel();
  if (matchMedia("(max-width: 980px)").matches) $("#panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderPanel() {
  const c = data.claims[selected];
  const panel = $("#panel");
  if (!c) { panel.innerHTML = `<div class="panel-empty"><h2>Claim #${selected}</h2><p>This claim is not in the current article.</p></div>`; return; }
  const ev = data.evidence[selected] ?? [];
  const sig = JSON.stringify([c.price_bps, c.trades, ev.map((e) => [e.id, e.backing, e.bond_state, verified.get(vkey(e.uri, e.content_hash))]), c.links.length]);
  if (sig === panelSig) return;
  panelSig = sig;
  const keep = { amt: $("#tAmt")?.value, ev: $("#tEv")?.value };

  const band = bandOf(c.price_bps);
  const hist = c.tape.map((t) => t.price_bps);
  const first = hist.length ? hist[0] : c.price_bps;
  const delta = c.price_bps - first;
  const links = c.links.map((lid) => data.links.find((l) => l.id === lid)).filter(Boolean);

  panel.innerHTML = `
    <div class="p-head"><span class="band-tag" style="--c:${colour(c.price_bps)}">${band.label}</span><span class="muted">claim #${c.id}${c.topic.includes("/") ? ` · ${esc(titleCase(c.topic.split("/").slice(1).join(" ")))}` : ""}</span></div>
    <p class="p-claim">${esc(c.text)}</p>
    <div class="bigprice" style="color:${colour(c.price_bps)}">${pct(c.price_bps)}%<small>${hist.length > 1 ? (delta >= 0 ? "▲" : "▼") + " " + Math.abs(pct(delta)) + " pts over the last " + hist.length + " trades" : "no trades yet"}</small></div>
    ${spark(hist.concat(c.price_bps))}
    <div class="stats">
      <div><b>${near(c.collateral)}</b>NEAR in pool</div>
      <div><b>${near(c.volume)}</b>NEAR traded</div>
      <div><b>${c.trades}</b>trades</div>
    </div>

    <h3>Evidence (${ev.length})</h3>
    ${ev.length ? ev.slice().sort((a, b) => Number(BigInt(b.independent) - BigInt(a.independent)) || Number(BigInt(b.backing) - BigInt(a.backing))).map(evidenceHtml).join("") : `<p class="muted">Nobody has attached a source yet.</p>`}

    ${links.length ? `<h3>Linked claims</h3><div class="links-list">${links.map((l) => linkHtml(l, c.id)).join("")}</div>` : ""}

    <h3>Recent trades</h3>
    ${c.tape.length ? `<ul class="tape">${c.tape.slice().reverse().slice(0, 8).map((t) => `<li><span>${ago(t.ts_ms)} ago</span><span><span class="${t.side === "Yes" ? "yes" : "no"}">${t.buy ? "bought" : "sold"} ${t.side.toUpperCase()}</span> · ${esc(short(t.who))}${t.evidence !== null ? ` · cites #${t.evidence}` : ""}</span><span>${near(t.amount)} → ${pct(t.price_bps)}%</span></li>`).join("")}</ul>` : `<p class="muted">No trades yet.</p>`}
    ${tradeHtml(c, ev)}`;

  if (keep.amt) $("#tAmt").value = keep.amt;
  if (keep.ev && $("#tEv")) $("#tEv").value = keep.ev;
  wireTrade(c);
}

function evidenceHtml(e) {
  const info = srcInfo(e.uri);
  const isQuote = /^\s*["“]/.test(e.note);
  const quote = e.note.replace(/^\s*["“]|["”]\s*$/g, "");
  const where = info.mock ? `<span class="muted" title="${esc(e.uri)}">${esc(info.label)}</span>`
    : info.href ? `<a href="${esc(info.href)}" target="_blank" rel="noopener noreferrer">${esc(info.label)}</a>` : esc(e.uri);
  return `<div class="ev">
    <div class="row1"><span class="stance ${e.stance}">${e.stance === "Support" ? "Supports" : "Refutes"}</span>${where}</div>
    ${quote ? (isQuote ? `<blockquote>“${esc(quote)}”</blockquote>` : `<p class="muted">Note: ${esc(quote)}</p>`) : ""}
    <div class="meta">
      <span title="${esc(e.content_hash)}">sha256 <code>${esc(e.content_hash.slice(0, 10))}…</code></span>
      <span>by ${esc(short(e.author))}</span>
      <span>${near(e.backing, 3)} NEAR behind it (${near(e.independent, 3)} from others)</span>
      <span>bond ${esc(e.bond_state.toLowerCase())}</span>
    </div>
    ${info.mock ? "" : `<div class="meta" style="margin-top:6px">${verifyBlock(e.uri, e.content_hash, e.id, e.note)}</div>
    ${info.href ? `<details><summary class="muted">or check it in a terminal</summary><code>curl -s '${esc(shq(e.uri))}' | shasum -a 256</code></details>` : ""}`}
  </div>`;
}

function linkHtml(l, self) {
  const other = l.a === self ? l.b : l.a;
  const oc = claimOf(other);
  const lc = data.linkClaims?.[l.claim_id];
  const rel = l.rel === "Implies" ? (l.a === self ? "implies" : "is implied by") : "cannot both be true with";
  const where = oc && articleOf(oc.topic) !== topic ? ` <span class="muted">(in ${esc(titleCase(articleOf(oc.topic)))})</span>` : "";
  return `<div data-claim="${other}" tabindex="0" role="button">This ${rel} “${esc(oc ? (oc.text.length > 64 ? oc.text.slice(0, 61) + "…" : oc.text) : "#" + other)}”${where}${oc ? ` (${pct(oc.price_bps)}%)` : ""}${lc ? ` · market is ${pct(lc.price_bps)}% sure of that` : ""}</div>`;
}

function tradeHtml(c, ev) {
  const canTrade = cfg.demo || accountId;
  const who = cfg.demo ? cfg.demoAccount : accountId;
  if (!canTrade && !/^(testnet|mainnet)$/.test(cfg.network)) {
    return `<div class="trade"><p class="muted">Trading from a browser needs a wallet on testnet or mainnet. This local run is read-only; the agents are trading.</p></div>`;
  }
  return `<div class="trade">
    <h3 style="margin-top:0">Trade${who ? ` as ${esc(short(who))}` : ""}</h3>
    ${canTrade ? `<div class="row"><input id="tAmt" type="number" min="0.02" step="0.1" value="0.5" aria-label="Amount in NEAR"><span class="muted">NEAR</span>
      <select id="tEv" aria-label="Cite evidence"><option value="">cite no evidence</option>${ev.map((e) => `<option value="${e.id}" data-stance="${e.stance}">cite #${e.id} · ${e.stance === "Support" ? "supports" : "refutes"} · ${esc(srcInfo(e.uri).host)}</option>`).join("")}</select></div>
      <div class="row"><button class="btn yes" id="tYes">Buy YES</button><button class="btn no" id="tNo">Buy NO</button><button class="ghost" id="tSell">Cash out my shares</button></div>
      <div class="quote-line" id="tQuote"></div><div class="msg" id="tMsg" role="status"></div>`
      : `<p class="muted">Connect a wallet to buy YES or NO on this sentence.</p><button class="btn primary" id="tConnect">Connect wallet</button>`}
  </div>`;
}

function wireTrade(c) {
  const ev = data.evidence[c.id] ?? [];
  $("#tConnect")?.addEventListener("click", walletToggle);
  if (!$("#tYes")) return;
  const quote = async (side) => {
    const amount = Number($("#tAmt").value);
    if (!(amount > 0)) return;
    try {
      const q = await api(`api/quote?claim=${c.id}&side=${side}&near=${amount}${accountId ? `&account=${encodeURIComponent(accountId)}` : ""}`);
      $("#tQuote").textContent = `${side === "Yes" ? "YES" : "NO"}: about ${(Number(BigInt(q.out) / 10n ** 18n) / 1e6).toFixed(2)} shares, price ${pct(q.price_before_bps)}% → ${pct(q.price_after_bps)}%`;
    } catch { $("#tQuote").textContent = ""; }
  };
  let t;
  const soon = (side) => { clearTimeout(t); t = setTimeout(() => quote(side), 250); };
  $("#tAmt").addEventListener("input", () => soon("Yes"));
  $("#tYes").addEventListener("mouseenter", () => soon("Yes"));
  $("#tNo").addEventListener("mouseenter", () => soon("No"));
  const go = async (side) => {
    const nearAmt = Number($("#tAmt").value);
    if (!Number.isFinite(nearAmt) || nearAmt < 0.012) { const m = $("#tMsg"); m.className = "msg err"; m.textContent = "The smallest trade is 0.012 NEAR."; return; }
    const evId = $("#tEv").value === "" ? null : Number($("#tEv").value);
    const evObj = ev.find((e) => e.id === evId);
    const msg = $("#tMsg");
    if (evObj && evObj.stance !== (side === "Yes" ? "Support" : "Refute")) { msg.className = "msg err"; msg.textContent = `Evidence #${evId} ${evObj.stance === "Support" ? "supports" : "refutes"} the claim; it can only be cited with a ${evObj.stance === "Support" ? "YES" : "NO"} trade.`; return; }
    msg.className = "msg"; msg.textContent = "Sending…";
    try {
      if (cfg.demo) await demoPost("api/demo/trade", { claim_id: c.id, side, near: nearAmt, evidence_id: evId });
      else await walletBuy(c.id, side, nearAmt, evId);
      msg.className = "msg ok"; msg.textContent = "Done.";
      panelSig = ""; await refresh();
    } catch (e) { msg.className = "msg err"; msg.textContent = e.message; }
  };
  $("#tYes").addEventListener("click", () => go("Yes"));
  $("#tNo").addEventListener("click", () => go("No"));
  $("#tSell")?.addEventListener("click", async () => {
    const msg = $("#tMsg");
    msg.className = "msg"; msg.textContent = "Selling…";
    try {
      if (!cfg.demo) {
        msg.textContent = (await walletSellAll(c.id)) ? "Sent to your wallet." : "You hold nothing in this claim.";
        msg.className = "msg ok"; panelSig = ""; await refresh(); return;
      }
      const r = await demoPost("api/demo/sell-all", { claim_id: c.id });
      const total = Object.values(r.paid).reduce((s, v) => s + BigInt(v), 0n);
      msg.className = "msg ok"; msg.textContent = total > 0n ? `Sold for ${near(total.toString(), 3)} NEAR.` : "You hold nothing in this claim.";
      panelSig = ""; await refresh();
    } catch (e) { msg.className = "msg err"; msg.textContent = e.message; }
  });
}

// ───────────────────────────── the swarm ─────────────────────────────

async function swarmLoop() {
  try { agents = await api("api/agents"); renderSwarm(); } catch { /* the main loop reports connectivity */ }
  setTimeout(swarmLoop, 2500);
}

function miniSpark(values, start) {
  const w = 220, h = 30, pad = 3;
  if (values.length < 2) return `<svg class="a-spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"></svg>`;
  const lo = Math.min(start, ...values), hi = Math.max(start, ...values);
  const span = hi - lo || 1;
  const x = (i) => pad + (i * (w - 2 * pad)) / (values.length - 1);
  const y = (v) => h - pad - ((v - lo) / span) * (h - 2 * pad);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const up = values[values.length - 1] >= start;
  return `<svg class="a-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Equity over time">
    <line x1="0" x2="${w}" y1="${y(start)}" y2="${y(start)}" stroke="var(--line)" stroke-dasharray="3 4"/>
    <path d="${d}" fill="none" stroke="var(${up ? "--good" : "--bad"})" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
}

function nowText(a) {
  if (!a.now) return `<span class="muted">waiting for its first pass…</span>`;
  const text = a.now.text.replace(/^claim #\d+: /, "").replace(/^link \d+ /, "");
  const ref = a.now.claimId !== null ? `<button data-claim="${a.now.claimId}">#${a.now.claimId}</button> ` : "";
  return `${ref}${esc(text)}`;
}

function renderSwarm() {
  if (!agents.length) return;
  for (const a of agents) {
    const h = equityHist.get(a.name) ?? [];
    const v = nearNum(a.equity);
    if (h.length === 0 || h[h.length - 1] !== v) h.push(v);
    if (h.length > 80) h.shift();
    equityHist.set(a.name, h);
  }
  const sum = (k) => agents.reduce((n, a) => n + a[k], 0);
  $("#swarmTotals").textContent = `${agents.length} agents · ${sum("reads")} sources read · ${sum("evidence")} pieces of evidence posted · ${sum("trades")} trades`;
  $("#swarm").innerHTML = agents.map((a) => {
    const pnl = nearNum(a.pnl);
    const start = nearNum(a.startEquity);
    return `<div class="agent ${a.active ? "active" : ""}">
      <div class="a-top"><span class="role ${a.role}">${a.role}</span><b>${esc(a.name)}</b><i class="dot" title="${a.active ? "working now" : "idle"}"></i></div>
      <div class="a-now">${nowText(a)}</div>
      <div class="a-nums">
        <div><b>${a.role === "arbiter" ? a.trades : a.reads}</b>${a.role === "arbiter" ? "legs traded" : "sources read"}</div>
        <div><b>${a.role === "arbiter" ? nearNum(a.positions).toFixed(1) : a.trades}</b>${a.role === "arbiter" ? "NEAR held" : "trades"}</div>
        <div><b class="${pnl > 0.005 ? "pos" : pnl < -0.005 ? "neg" : ""}" title="cash ${near(a.balance)} + positions valued at what selling now would pay ${near(a.positions)} − start ${start.toFixed(2)}">${signed(pnl)}</b>NEAR profit</div>
      </div>
      ${miniSpark(equityHist.get(a.name) ?? [], start)}
    </div>`;
  }).join("");
}

// ───────────────────────────── lies ─────────────────────────────

async function loadLies() {
  let all = [];
  try { all = await api("api/demo/lies"); } catch { all = []; }
  lies = all.filter((l) => l.kind !== "add");
  adds = all.filter((l) => l.kind === "add");
  renderLieOptions();
}

function renderLieOptions() {
  const sel = $("#lieSel");
  if (!sel) return;
  const cur = sel.value;
  const order = lies.slice().sort((x, y) => (y.article === topic) - (x.article === topic));
  sel.innerHTML = order.map((l) => `<option value="${esc(l.id)}">${esc(titleCase(l.article))}: “${esc(l.text)}”${l.note ? ` — ${esc(l.note)}` : ""}</option>`).join("");
  if (lies.some((l) => l.id === cur && l.article === topic)) sel.value = cur;
  $("#playStory").disabled = lies.length === 0 || story.running;
  $("#lieGo").disabled = lies.length === 0;
  const asel = $("#addSel");
  const acur = asel.value;
  const aorder = adds.slice().sort((x, y) => (y.article === topic) - (x.article === topic));
  asel.innerHTML = aorder.map((l) => `<option value="${esc(l.id)}">${esc(titleCase(l.article))}: “${esc(l.text)}”</option>`).join("");
  if (adds.some((l) => l.id === acur)) asel.value = acur;
  $("#playAdd").disabled = adds.length === 0 || story.running;
  $("#addGo").disabled = adds.length === 0;
}

function renderDemoOptions() {
  if (!cfg.demo) return;
  const art = $("#injArticle");
  const aHtml = topics.map((t) => `<option value="${esc(t.topic)}">${esc(t.title)}</option>`).join("");
  if (art.dataset.sig !== aHtml) { const cur = art.value; art.innerHTML = aHtml; art.dataset.sig = aHtml; art.value = cur || topic; }
  const addArt = $("#addArticle");
  if (addArt.dataset.sig !== aHtml) { const cur = addArt.value; addArt.innerHTML = aHtml; addArt.dataset.sig = aHtml; addArt.value = cur || topic; }
  const sel = $("#injContra");
  const cur = sel.value;
  const groups = new Map();
  for (const c of claimIndex) { if (!groups.has(c.article)) groups.set(c.article, []); groups.get(c.article).push(c); }
  const html = `<option value="">nothing in particular</option>` + [...groups.entries()].map(([art2, cs]) =>
    `<optgroup label="${esc(cs[0].articleTitle)}">${cs.map((c) => `<option value="${c.id}">#${c.id} ${esc(c.text.length > 52 ? c.text.slice(0, 49) + "…" : c.text)}</option>`).join("")}</optgroup>`).join("");
  if (sel.dataset.sig !== html) { sel.innerHTML = html; sel.dataset.sig = html; sel.value = cur; }
}

async function injectPicked() {
  const btn = $("#lieGo"), msg = $("#lieMsg");
  btn.disabled = true; msg.className = "msg"; msg.textContent = "Writing to the chain…";
  try {
    const r = await demoPost("api/demo/inject", { lie_id: $("#lieSel").value, seed_near: 2, pump_near: 2 });
    const warn = (r.warnings ?? []).join(" ");
    msg.className = warn ? "msg" : "msg ok"; msg.textContent = `In the article as claim #${r.id}, priced ${pct(r.claim.price_bps)}%. Watch the agents.${warn ? ` Note: ${warn}` : ""}`;
    const l = lies.find((x) => x.id === $("#lieSel").value);
    if (l) await switchArticle(l.article);
    await refresh();
    select(r.id);
  } catch (e) { msg.className = "msg err"; msg.textContent = e.message; }
  btn.disabled = false;
}

// A true sentence, picked or typed: opened at 50% with a modest pool and no pump, so the agents are the ones who move it.
async function addPicked() {
  const btn = $("#addGo"), msg = $("#addMsg");
  btn.disabled = true; msg.className = "msg"; msg.textContent = "Writing to the chain…";
  try {
    const r = await demoPost("api/demo/inject", { lie_id: $("#addSel").value });
    msg.className = "msg ok"; msg.textContent = r.existing ? `Already in the article as claim #${r.id}, priced ${pct(r.claim.price_bps)}%.` : `Added as claim #${r.id}, priced ${pct(r.claim.price_bps)}%. Watch the agents check it.`;
    const a = adds.find((x) => x.id === $("#addSel").value);
    if (a) await switchArticle(a.article);
    await refresh();
    select(r.id);
  } catch (e) { msg.className = "msg err"; msg.textContent = e.message; }
  btn.disabled = false;
}

async function addCustom(ev) {
  ev.preventDefault();
  const btn = $("#addBtn"), msg = $("#addFormMsg");
  btn.disabled = true; msg.className = "msg"; msg.textContent = "Writing to the chain…";
  try {
    const art = $("#addArticle").value || topic;
    const r = await demoPost("api/demo/inject", { topic: art, text: $("#addText").value, contradicts: [], seed_near: 1, pump_near: 0, prior_bps: 5000 });
    msg.className = "msg ok"; msg.textContent = r.existing ? `Already in the article as claim #${r.id}, priced ${pct(r.claim.price_bps)}%.` : `Added as claim #${r.id}, priced ${pct(r.claim.price_bps)}%. Watch the agents check it.`;
    await switchArticle(articleOf(art));
    await refresh();
    select(r.id);
  } catch (e) { msg.className = "msg err"; msg.textContent = e.message; }
  btn.disabled = false;
}

async function injectCustom(ev) {
  ev.preventDefault();
  const btn = $("#injBtn"), msg = $("#injMsg");
  btn.disabled = true; msg.className = "msg"; msg.textContent = "Writing to the chain…";
  try {
    const art = $("#injArticle").value || topic;
    const r = await demoPost("api/demo/inject", {
      topic: art, text: $("#injText").value, contradicts: $("#injContra").value ? [Number($("#injContra").value)] : [],
      seed_near: Number($("#injSeed").value), pump_near: Number($("#injPump").value), prior_bps: 8000,
    });
    const warn = (r.warnings ?? []).join(" ");
    msg.className = warn ? "msg" : "msg ok"; msg.textContent = `Injected as claim #${r.id}, now priced ${pct(r.claim.price_bps)}%. Watch the agents.${warn ? ` Note: ${warn}` : ""}`;
    await switchArticle(articleOf(art));
    await refresh();
    select(r.id);
  } catch (e) { msg.className = "msg err"; msg.textContent = e.message; }
  btn.disabled = false;
}

async function demoLedger() {
  const me = await api("api/demo/me");
  const bal = BigInt(me.balance);
  if (baseline === null) baseline = bal;
  const d = Number((bal - baseline) / 10n ** 18n) / 1e6;
  $("#ledger").innerHTML = `Your balance: <b>${near(me.balance, 2)} NEAR</b> · since you arrived: <b style="color:${d < -0.005 ? "var(--bad)" : "inherit"}">${d >= 0 ? "+" : ""}${d.toFixed(3)} NEAR</b>${d < -0.005 ? ". Cash out the false claim to see what the lie cost." : ""} <span class="muted" title="Every visitor shares this account, so someone else's trade changes the figures.">(shared account)</span>`;
}

// ───────────────────────────── the story ─────────────────────────────
// A guided run: inject a lie, then narrate what the agents do about it as it happens, driven by the same data the page
// shows (the activity feed and the prices), never by a script that pretends.

const STEPS_LIE = ["A lie enters", "Agents read", "Evidence on chain", "The market reacts", "You verify", "The lie costs money"];
const STEPS_ADD = ["A sentence is added", "Agents read", "Evidence on chain", "The market reacts", "You verify", "It is established"];
let STEPS = STEPS_LIE;
let story = { running: false, stop: false };
const STOP = Symbol("stop");

function stage(step, html) {
  $("#stage").hidden = false;
  document.body.classList.add("staging");
  $("#stageSteps").innerHTML = STEPS.map((s, i) => `<li class="${i < step ? "done" : i === step ? "now" : ""}">${i + 1}. ${s}</li>`).join("");
  $("#stageText").innerHTML = html;
}

function stopStory() {
  story.stop = true;
  $("#stage").hidden = true;
  // The caption must not outlive the story: whatever waits for a story's last words (the autopilot, a test) would otherwise
  // read the previous story's and think the next one had already finished.
  $("#stageText").textContent = "";
  $("#stageSteps").textContent = "";
  document.body.classList.remove("staging");
  document.querySelectorAll(".spot").forEach((e) => e.classList.remove("spot"));
}

async function waitFor(pred, ms, tick = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (story.stop) throw STOP;
    const v = pred();
    if (v) return v;
    await waitMs(tick);
  }
  return null;
}

function spotlight(id) {
  document.querySelectorAll(".spot").forEach((e) => e.classList.remove("spot"));
  const el = document.querySelector(`#body .sent[data-claim="${id}"]`) ?? document.querySelector(`#rejected li[data-claim="${id}"]`);
  if (el) { el.classList.add("spot"); el.scrollIntoView({ behavior: "smooth", block: "center" }); }
}

const priceOf = (id) => (data.article.body.concat(data.article.rejected).find((s) => s.claimId === id) ?? {}).priceBps;
// The earliest matching event, so the narration follows the order things happened in.
const fromFeed = (id, kind, since, keep = () => true) => () => feedItems.slice().reverse().find((a) => a.claimId === id && a.kind === kind && a.ts >= since && keep(a));
const whoIs = (account) => agents.find((a) => a.account === account);
const afterColon = (t) => t.replace(/^claim #\d+: /, "");

// kind "lie": a false sentence backed with money that the agents correct. kind "add": a true sentence added at 50% that the
// agents confirm. The agents behave the same way for both; only what we narrate and wait for differs.
async function playStory(kind = "lie") {
  if (story.running) return;
  const isAdd = kind === "add";
  const pool = isAdd ? adds : lies;
  const lie = pool.find((l) => l.id === $(isAdd ? "#addSel" : "#lieSel").value);
  if (!lie) return;
  story = { running: true, stop: false };
  STEPS = isAdd ? STEPS_ADD : STEPS_LIE;
  $("#playStory").disabled = true;
  $("#playAdd").disabled = true;
  try {
    const before = BigInt((await api("api/demo/me")).balance);
    const lieText = lie.text.replace(/\.$/, "");
    stage(0, isAdd
      ? `Anyone can add a sentence to this encyclopedia, and nobody checks it first. Here is a true one: <q>${esc(lieText)}</q>`
      : `Anyone can add a sentence to this encyclopedia. Here is a false one, backed with real money: <q>${esc(lieText)}</q>`);
    await switchArticle(lie.article);
    await sleepMs(2200);
    const inj = await demoPost("api/demo/inject", { lie_id: lie.id, seed_near: isAdd ? 1 : 2, pump_near: isAdd ? 0 : 2 });
    const t0 = inj.at; // the server's clock, the same one that stamps the agents' events
    await refresh();
    spotlight(inj.id);
    select(inj.id);
    if (inj.existing) {
      // Adding the same sentence twice does nothing: say so, and show the one that is there, rather than narrate a story that did not happen.
      stage(0, `<q>${esc(lieText)}</q> is already in the article, at <b>${pct(inj.enteredBps)}%</b>: a sentence is only added once. Pick another to watch one being added.`);
      throw STOP;
    }
    const warned = (inj.warnings ?? []).length ? ` <small>(${esc(inj.warnings.join(" "))})</small>` : "";
    stage(0, isAdd
      ? `It is in the article at <b>${pct(inj.enteredBps)}%</b>: the market has no opinion yet. Nobody edited the page: it is a reading of the prices, and this sentence has not been checked by anyone.${warned}`
      : `It is in the article at <b>${pct(inj.enteredBps)}%</b>. Nobody edited the page: it is a reading of the prices, and the market has just been told a lie.${warned}`);
    await sleepMs(4200);

    stage(1, `The agents watch every price. Each has its own NEAR account and is paid only for moving a price toward what a checkable source says. They are searching Wikipedia now…`);
    const read = await waitFor(fromFeed(inj.id, "source", t0), 120000);
    if (read) stage(1, `<b>${esc(read.agent)}</b> opens the Wikipedia page <q>${esc((/reading "(.+?)"/.exec(read.text) ?? [])[1] ?? "a source")}</q>, pinned to an exact revision.`);
    const judged = await waitFor(fromFeed(inj.id, "judge", t0), 90000);
    if (judged) {
      stage(1, `The judge must quote the page <i>word for word</i>, or its verdict is thrown out. <b>${esc(judged.agent)}</b> got: ${esc(afterColon(judged.text))}`);
      await sleepMs(5200);
    }

    stage(2, `The source goes on chain as <b>evidence</b>: its address, the sha256 of its content, the exact quote, and a bond the agent loses if nobody follows it.`);
    const evid = await waitFor(fromFeed(inj.id, "evidence", t0, (a) => !a.data?.reused), 90000);
    await refresh();
    select(inj.id);
    if (evid) { stage(2, `<b>${esc(evid.agent)}</b> posted it: ${esc(afterColon(evid.text))}`); await sleepMs(4200); }

    stage(3, `The agent now bets its own money on what it found. The price is the market's confidence, and it has just met someone who read the source.`);
    // A lie is done when the market has pushed it out of the article. A true sentence is done once an agent has bet on it,
    // citing its evidence, and the price has settled for a few seconds (a second agent often follows the first).
    const gone = await waitFor(isAdd
      ? () => (data.claims[inj.id]?.tape ?? []).some((t) => t.evidence !== null)
      : () => data.article.rejected.some((s) => s.claimId === inj.id), 150000);
    if (gone && isAdd) await sleepMs(6000);
    await refresh();
    if (!gone) {
      stage(3, `The agents are slower than usual (Wikipedia limits how fast they can read). The price is <b>${pct(priceOf(inj.id) ?? 0)}%</b>; you can keep watching.`);
      throw STOP;
    }
    // Replay what actually happened, trade by trade, from the claim's own tape. A lie's first trade is our own pump.
    let prev = pct(inj.enteredBps);
    for (const t of (data.claims[inj.id]?.tape ?? []).slice(isAdd ? 0 : 1)) {
      if (story.stop) throw STOP;
      const w = whoIs(t.who);
      const name = w ? w.name : short(t.who);
      const why = t.evidence !== null ? `citing the evidence it posted (#${t.evidence})` : w?.role === "arbiter" ? `because a claim that contradicts a true one cannot also be right` : "";
      stage(3, `<b>${esc(name)}</b> ${t.buy ? "bought" : "sold"} <b>${t.side.toUpperCase()}</b> with ${near(t.amount)} NEAR ${why}: <b>${prev}% → ${pct(t.price_bps)}%</b>`);
      prev = pct(t.price_bps);
      await sleepMs(3000);
    }
    spotlight(inj.id);
    if (isAdd) stage(3, `<q>${esc(lieText)}</q> now stands at <b>${pct(priceOf(inj.id) ?? prev)}%</b>. Nobody voted and nobody approved it: someone read a source, quoted it, and put money behind it.`);
    else stage(3, `Below 30% a claim leaves the article. <q>${esc(lieText)}</q> is now under <b>Rejected by the market</b>, and the page records a new revision. No moderator, no vote.`);
    await sleepMs(5200);

    stage(4, `Do not take our word for it. Your browser is fetching the exact Wikipedia revision the agents cited, hashing it, and looking for the quote in it…`);
    select(inj.id);
    const evs = (data.evidence[inj.id] ?? []).filter((e) => e.stance === (isAdd ? "Support" : "Refute") && !srcInfo(e.uri).mock);
    if (evs.length) {
      const r = await verify(evs[0].uri, evs[0].content_hash, evs[0].id, evs[0].note);
      stage(4, r?.status === "ok" ? `${esc(r.text)}` : `${esc(r?.text ?? "That source could not be checked from here.")}`);
    } else stage(4, `This run used the offline test corpus, so there is no live page to re-fetch. With Wikipedia as the source this step re-hashes the cited revision in your browser.`);
    await sleepMs(5200);

    if (isAdd) {
      await sleepMs(3200);
      await refresh();
      const after = BigInt((await api("api/demo/me")).balance);
      const spent = Number((before - after) / 10n ** 18n) / 1e6;
      stage(5, `Established: <q>${esc(lieText)}</q> is in the article at <b>${pct(priceOf(inj.id) ?? 0)}%</b>, cited to a page anyone can re-hash. Adding it cost you <b>${spent.toFixed(2)} NEAR</b> (0.07 is a fee; the rest is the pool's starting liquidity, which stays in the market for others to trade against). The same pipeline that confirmed this refutes a lie. <button class="ghost" id="again" style="margin-left:8px">Add another</button>`);
    } else {
      stage(5, `Cashing out your shares in the lie…`);
      await sleepMs(3200);
      await demoPost("api/demo/sell-all", { claim_id: inj.id });
      const after = BigInt((await api("api/demo/me")).balance);
      const lost = Number((before - after) / 10n ** 18n) / 1e6;
      stage(5, `The lie cost you <b>${lost.toFixed(2)} NEAR</b>. Most of it went to whoever bet against it, the agents that corrected it, which is why they keep watching; the rest stays in the market as liquidity and fees. <button class="ghost" id="again" style="margin-left:8px">Play another</button>`);
    }
    // The picker re-sorts itself each time the article changes, so "the next option" is not the next lie: step through the list itself.
    $("#again")?.addEventListener("click", () => {
      stopStory();
      story = { running: false, stop: false };
      const next = pool[(pool.findIndex((l) => l.id === lie.id) + 1) % pool.length];
      $(isAdd ? "#addSel" : "#lieSel").value = next.id;
      playStory(kind);
    });
    await refresh();
  } catch (e) {
    if (e !== STOP) stage(5, `The story stopped: ${esc(e instanceof Error ? e.message : String(e))}`);
  } finally {
    story.running = false;
    $("#playStory").disabled = lies.length === 0;
    $("#playAdd").disabled = adds.length === 0;
    document.querySelectorAll(".spot").forEach((el) => el.classList.remove("spot"));
  }
}

// ───────────────────────────── feed ─────────────────────────────

async function feedLoop() {
  try {
    const items = await api(`api/activity?since=${feedSince}`);
    if (items.length) {
      feedSince = items[items.length - 1].ts;
      feedItems = items.concat(feedItems).slice(0, 200);
      feedItems.sort((a, b) => b.ts - a.ts);
      $("#feed").innerHTML = feedItems.filter((a) => a.kind !== "scan").slice(0, 70).map((a) => `<li class="k-${a.kind}"><span class="t">${clock(a.ts)}</span><span class="a">${esc(a.agent)}</span><span class="x">${esc(a.text)}</span></li>`).join("");
    }
  } catch { /* the main loop reports connectivity */ }
  setTimeout(feedLoop, 2000);
}

// ───────────────────────────── toasts ─────────────────────────────

function toast(html) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<b>Article revised.</b> ${html}`;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 9000);
}

// ───────────────────────────── wallet (testnet / mainnet only) ─────────────────────────────

let selector = null, modal = null;
async function initWallet() {
  if (walletReady) return walletReady;
  walletReady = (async () => {
    const v = "10.1.4";
    const [{ setupWalletSelector }, { setupModal }, { setupMyNearWallet }, { setupMeteorWallet }] = await Promise.all([
      import(`https://esm.sh/@near-wallet-selector/core@${v}`),
      import(`https://esm.sh/@near-wallet-selector/modal-ui@${v}`),
      import(`https://esm.sh/@near-wallet-selector/my-near-wallet@${v}`),
      import(`https://esm.sh/@near-wallet-selector/meteor-wallet@${v}`),
    ]);
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = `https://esm.sh/@near-wallet-selector/modal-ui@${v}/styles.css`;
    document.head.appendChild(css);
    selector = await setupWalletSelector({ network: cfg.network, modules: [setupMyNearWallet(), setupMeteorWallet()] });
    modal = setupModal(selector, { contractId: cfg.contractId });
    selector.store.observable.subscribe((state) => {
      const a = state.accounts.find((x) => x.active);
      accountId = a ? a.accountId : null;
      $("#wallet").textContent = accountId ? `${short(accountId)} · disconnect` : "Connect wallet";
      panelSig = "";
      if (data && selected !== null) renderPanel();
    });
  })();
  return walletReady;
}

async function walletToggle() {
  try { await initWallet(); } catch (e) { toast(`Wallet library failed to load: ${esc(e.message)}`); return; }
  if (accountId) { const w = await selector.wallet(); await w.signOut(); accountId = null; $("#wallet").textContent = "Connect wallet"; }
  else modal.show();
}

async function walletBuy(claimId, side, nearAmt, evidenceId) {
  await initWallet();
  if (!accountId) throw new Error("Connect a wallet first");
  const deposit = (BigInt(Math.round(nearAmt * 1e6)) * 10n ** 18n).toString();
  // The price can move before the wallet signs (agents trade all the time): the contract refuses the buy unless it gets at
  // least 95% of the shares quoted now.
  const q = await api(`api/quote?claim=${claimId}&side=${side}&near=${nearAmt}&account=${encodeURIComponent(accountId)}`);
  const minShares = ((BigInt(q.out) * 95n) / 100n).toString();
  const w = await selector.wallet();
  await w.signAndSendTransaction({
    receiverId: cfg.contractId,
    actions: [{ type: "FunctionCall", params: { methodName: "buy", args: { claim_id: claimId, side, min_shares: minShares, evidence_id: evidenceId }, gas: String(80n * 10n ** 12n), deposit } }],
  });
}

/** Sells everything the connected wallet holds in a claim, accepting at least 95% of what selling pays right now. */
async function walletSellAll(claimId) {
  await initWallet();
  if (!accountId) throw new Error("Connect a wallet first");
  const pos = await api(`api/position?claim=${claimId}&account=${encodeURIComponent(accountId)}`);
  const actions = [];
  for (const side of ["Yes", "No"]) {
    if (BigInt(pos[side].out) <= 0n) continue;
    actions.push({ type: "FunctionCall", params: { methodName: "sell", args: { claim_id: claimId, side, shares: pos[side].shares, min_proceeds: ((BigInt(pos[side].out) * 95n) / 100n).toString() }, gas: String(80n * 10n ** 12n), deposit: "0" } });
  }
  if (!actions.length) return false;
  const w = await selector.wallet();
  await w.signAndSendTransaction({ receiverId: cfg.contractId, actions });
  return true;
}

// ───────────────────────────── events ─────────────────────────────

document.addEventListener("click", (e) => {
  const v = e.target.closest("[data-verify]");
  if (v) { void verify(v.dataset.uri, v.dataset.hash, Number(v.dataset.eid), v.dataset.note || null); return; }
  const r = e.target.closest("[data-ref]");
  if (r) { e.preventDefault(); gotoRef(Number(r.dataset.ref)); return; }
  const tab = e.target.closest(".tab");
  if (tab) { void switchArticle(tab.dataset.topic); return; }
  const t = e.target.closest("[data-claim]");
  if (t) { e.preventDefault(); void goToClaim(Number(t.dataset.claim)); }
});
document.addEventListener("keydown", (e) => {
  const tab = e.target.closest?.(".tab");
  if (tab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
    e.preventDefault();
    const tabs = [...document.querySelectorAll(".tab")];
    const i = tabs.indexOf(tab);
    const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    void switchArticle(tabs[next].dataset.topic).then(() => document.querySelector(`.tab[data-topic="${tabs[next].dataset.topic}"]`)?.focus());
    return;
  }
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.("[data-claim][role=button]")) { e.preventDefault(); void goToClaim(Number(e.target.dataset.claim)); }
});

boot();

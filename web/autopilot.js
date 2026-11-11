// Autopilot: a hands-free tour of the real page. A visible cursor moves to the real buttons and clicks them, captions say what
// is happening, and every wait follows the page itself (the story's own caption, the Verify result), so it takes as long as the
// agents take. Nothing is faked: the clicks are the same ones a person would make.
//
//   http://localhost:8787/?autopilot=1            start straight away
//   http://localhost:8787/?autopilot=1&pace=1.5   slower captions (1.5 = half as fast again), for a calmer recording
//   or press the "▶ Autopilot" button that appears at the bottom left when the demo controls are on.
// Esc stops it. It needs the demo controls (they add the sentences), so it does nothing on a read-only deployment.

const params = new URLSearchParams(location.search);
const PACE = Math.max(0.3, Number(params.get("pace") ?? 1) || 1);
// `spd` shortens everything the story itself pauses on, and the cursor's travel, for a recording that must be short (X lets a free
// account post 140 seconds). It never shortens a wait on the chain or the agents: those take as long as they take.
const SPD = Math.max(0.3, Math.min(1.5, Number(params.get("spd") ?? 1) || 1));
const $ = (s) => document.querySelector(s);
const STOP = Symbol("stop");
const BAR = 136; // height of the strip for words, in px; the same number is --apBar in the stylesheet below
let running = false;
let stopped = false;

const sleep = (ms) => new Promise((res, rej) => {
  const t0 = Date.now();
  const tick = () => (stopped ? rej(STOP) : Date.now() - t0 >= ms ? res() : setTimeout(tick, 50));
  tick();
});
const pause = (ms) => sleep(ms * PACE);

async function until(pred, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (stopped) throw STOP;
    const v = pred();
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`autopilot gave up waiting for ${what}`);
}

// ── the overlay: a cursor, a click ripple, a caption ─────────────────────────────────────────────────────────────────

const css = document.createElement("style");
css.textContent = `
#apCursor { position: fixed; left: 0; top: 0; width: 30px; height: 30px; z-index: 10000; pointer-events: none; opacity: 0;
  transition: transform .9s cubic-bezier(.45,.05,.25,1), opacity .3s; filter: drop-shadow(0 2px 4px rgba(0,0,0,.45)); }
#apCursor.on { opacity: 1; }
.apRipple { position: fixed; z-index: 9999; pointer-events: none; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;
  border: 3px solid var(--accent, #2f5bea); animation: apRipple .6s ease-out forwards; }
@keyframes apRipple { to { transform: scale(4.5); opacity: 0; } }
/* While the tour runs, all the words live in a strip of their own at the bottom, and the page scrolls in the space above it, so
   nothing it says covers anything it shows. The strip holds the autopilot's captions and, when a story runs, the story's own
   narration bar (which is moved into the same place). */
html.ap { overflow: hidden; background: var(--ink, #1c1b19); }
html.ap body { position: fixed; inset: 0 0 var(--apBar, 136px) 0; overflow-x: hidden; overflow-y: auto; scroll-behavior: smooth; }
html.ap body.staging { padding-bottom: 0; }
html.ap .stage { left: 0; right: 0; bottom: 0; width: auto; transform: none; border-radius: 0; box-shadow: none; z-index: 9999; min-height: var(--apBar, 136px);
  box-sizing: border-box; align-content: center; padding: 12px max(24px, calc((100vw - 980px) / 2)); }
html.ap .toasts { top: auto; bottom: calc(var(--apBar, 136px) + 14px); }
#apCaption { position: fixed; left: 0; right: 0; bottom: 0; height: var(--apBar, 136px); z-index: 9998; box-sizing: border-box; display: flex; align-items: center; justify-content: center;
  background: var(--ink, #1c1b19); color: var(--bg, #fff); padding: 10px max(24px, calc((100vw - 980px) / 2)); font: 23px/1.4 var(--serif, Georgia, serif); text-align: center;
  opacity: 0; transition: opacity .35s; pointer-events: none; }
#apCaption.on { opacity: 1; }
#apCaption b { color: inherit; border-bottom: 2px solid var(--accent, #2f5bea); }
.apSpot { outline: 3px solid var(--accent, #2f5bea) !important; outline-offset: 4px; border-radius: 6px; }
#apStart { position: fixed; left: 14px; bottom: 14px; z-index: 40; }
body.staging #apStart { display: none; }
`;
document.head.appendChild(css);

const cursor = Object.assign(document.createElement("div"), { id: "apCursor" });
cursor.innerHTML = `<svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 2l15 9-6.5 1.6L9.6 19z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
const caption = Object.assign(document.createElement("div"), { id: "apCaption" });
caption.setAttribute("role", "status");
document.body.append(cursor, caption);

let cx = innerWidth * 0.5, cy = innerHeight * 0.55;
const place = (x, y) => { cx = x; cy = y; cursor.style.transform = `translate(${x - 4}px, ${y - 2}px)`; };
place(cx, cy);

// One wrapper, so the caption is a single flex item and bold phrases stay inline with the sentence around them.
const say = (html) => { caption.innerHTML = `<span>${html}</span>`; caption.classList.add("on"); };
const hush = () => caption.classList.remove("on");

function spot(el, ms = 3000) {
  if (!el) return;
  el.classList.add("apSpot");
  setTimeout(() => el.classList.remove("apSpot"), ms);
}

async function moveTo(el) {
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  await sleep(800 * Math.min(1, SPD));
  const r = el.getBoundingClientRect();
  cursor.classList.add("on");
  // The strip at the bottom is not part of the page: keep the cursor above it.
  place(Math.min(innerWidth - 20, Math.max(20, r.left + Math.min(r.width / 2, 120))), Math.min(innerHeight - BAR - 20, Math.max(20, r.top + r.height / 2)));
  await sleep(1000 * Math.min(1, SPD));
}

async function click(el) {
  await moveTo(el);
  const ripple = Object.assign(document.createElement("div"), { className: "apRipple" });
  ripple.style.left = `${cx}px`; ripple.style.top = `${cy}px`;
  document.body.appendChild(ripple);
  setTimeout(() => ripple.remove(), 700);
  await sleep(120);
  el.click();
  await sleep(400);
}

// Picks an option of a <select> the way a person would (move there, choose), then lets the page react to the change.
async function choose(selector, text) {
  const sel = await until(() => $(selector), 5000, selector);
  await moveTo(sel);
  const opt = [...sel.options].find((o) => o.textContent.includes(text));
  if (!opt) throw new Error(`autopilot: no option containing "${text}" in ${selector}`);
  sel.value = opt.value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  spot(sel, 2000);
  await sleep(900);
}

const stageText = () => $("#stageText")?.innerText ?? "";
// A story's last caption stays in the bar until the next story writes over it, so wait for the next one's words only after this.
const clearStage = () => { const t = $("#stageText"); if (t) t.textContent = ""; };

// ── the tour ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function tour() {
  await until(() => document.querySelectorAll(".sent").length > 0, 60000, "the article");
  await until(() => !$("#demoCard")?.hidden && $("#addSel")?.options.length, 30000, "the demo controls (start the server with DEMO_ENABLED=1, or use npm run demo)");
  document.body.scrollTo({ top: 0, behavior: "smooth" });
  await sleep(700);

  say(`<b>Verity</b>: an encyclopedia where <b>every sentence has a price</b>.`);
  await pause(4200);

  await click($('.tab[data-topic="pluto"]'));
  say(`Each number is the market's probability that the sentence is true. <b>Nobody edits this page.</b> It is a reading of the prices.`);
  await pause(6500);

  const sent = await until(() => document.querySelector("#body .sent[data-claim]"), 10000, "a sentence");
  spot(sent, 6500);
  await click(sent);
  say(`Click any sentence: the market behind it, the sources the agents attached, the <b>exact quote</b> and a <b>hash</b> anyone can check.`);
  await pause(7000);

  await moveTo($("#swarmCard"));
  say(`Agents do the work. Each has <b>its own NEAR account and its own money</b>. Nobody tells them what is true.`);
  await pause(6500);

  await moveTo($("#demoCard"));
  say(`Anyone can add a sentence, and <b>nobody checks it first</b>. Here is a true one.`);
  await pause(4200);
  await choose("#addSel", "Charon");
  hush();
  clearStage();
  await click($("#playAdd"));
  // From here the page narrates in its own bottom bar, from the chain and the agents' activity, until it says "Established".
  // On a second run the sentence is already there and the page says so instead; that ends the step too.
  await until(() => /Established:|already in the article/.test(stageText()), 300000, "the add story to finish");
  await pause(7500);
  await click($("#stageStop"));

  await moveTo($("#demoCard"));
  say(`Now the opposite: a <b>lie</b>, backed with real money, to make it look believable.`);
  await pause(4500);
  await choose("#lieSel", "twelve");
  hush();
  clearStage();
  await click($("#playStory"));
  await until(() => /lie cost you/.test(stageText()), 300000, "the lie story to finish");
  await pause(8500);
  await click($("#stageStop"));

  const refs = await until(() => $("#verifyAll"), 5000, "the references");
  await moveTo(refs);
  say(`<b>Do not trust us.</b> Every source has a Verify button: your browser fetches the Wikipedia page, hashes it, and finds the quote.`);
  await pause(6500);
  const v = await until(() => document.querySelector("[data-verify]:not([disabled])"), 5000, "a Verify button");
  await click(v);
  await until(() => document.querySelector(".vres"), 60000, "the Verify result");
  spot(document.querySelector(".vres"), 7000);
  say(`Same hash as the chain, and the quote is really in the page.`);
  await pause(7000);

  say(`The default judge is rule-based and says nothing when unsure. A language model plugs into the same pipeline.<br><b>Every sentence has a price.</b>`);
  await pause(9000);
  hush();
}

export async function start() {
  if (running) return;
  running = true; stopped = false;
  $("#apStart")?.setAttribute("hidden", "");
  document.documentElement.classList.add("ap");
  window.verityPace = SPD;
  try { await tour(); }
  catch (e) { if (e !== STOP) { say(`Autopilot stopped: ${e instanceof Error ? e.message : String(e)}`); console.error(e); await new Promise((r) => setTimeout(r, 6000)); hush(); } }
  finally {
    running = false;
    delete window.verityPace;
    document.documentElement.classList.remove("ap");
    cursor.classList.remove("on");
    hush();
    document.querySelectorAll(".apSpot").forEach((e) => e.classList.remove("apSpot"));
    $("#apStart")?.removeAttribute("hidden");
  }
}

addEventListener("keydown", (e) => { if (e.key === "Escape" && running) { stopped = true; } });

// The start button appears only when the demo controls do.
(async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 30000 && ($("#demoCard")?.hidden ?? true)) await new Promise((r) => setTimeout(r, 500));
  if ($("#demoCard")?.hidden ?? true) return;
  const b = Object.assign(document.createElement("button"), { id: "apStart", className: "btn story", textContent: "▶ Autopilot" });
  b.title = "A hands-free tour: it clicks the real buttons and narrates. Esc stops it.";
  b.addEventListener("click", () => void start());
  document.body.appendChild(b);
  if (params.get("autopilot")) void start();
})();

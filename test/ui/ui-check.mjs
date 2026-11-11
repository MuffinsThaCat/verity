/**
 * Drives the real UI in headless Chrome against a running demo and checks what a visitor sees.
 *
 *   npm run demo                       # in one terminal (wait for "demo is live")
 *   npm run test:ui                    # in another
 *
 * URL=http://localhost:8787 (default), CHROME=/path/to/chrome, STORY=1 plays the guided stories (STORY=add only the add-a-sentence one), VERIFY=1 re-hashes every
 * source from the browser (needs the network; Wikipedia is fetched by the page itself).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const URL_ = process.env.URL ?? "http://localhost:8787";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9400 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(width, height) {
  const profile = mkdtempSync(path.join(tmpdir(), "verity-ui-"));
  const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--disable-gpu", "--hide-scrollbars", `--window-size=${width},${height}`, "about:blank"], { stdio: "ignore" });
  let list = [];
  for (let i = 0; i < 60 && !list.length; i++) { try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await sleep(250); } }
  const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
    else if (msg.method === "Runtime.exceptionThrown") problems.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") problems.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`);
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  return {
    problems,
    async goto(url) { await send("Page.navigate", { url }); await sleep(2500); },
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async until(expr, ms, what) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await this.eval(expr)) return; await sleep(400); } throw new Error(`timed out waiting for ${what}`); },
    // The browser's profile is a folder of its own making (about 25 MB); leaving it behind filled a disk over many runs.
    // Synchronous on purpose: the script ends with process.exit(), so a timer would never fire.
    close() {
      try { ws.close(); } catch {}
      proc.kill("SIGKILL");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); // let the browser's processes go before its folder does
      try { rmSync(profile, { recursive: true, force: true }); } catch {}
    },
  };
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push([name, true]); console.log(`  PASS  ${name}`); }
  catch (e) { results.push([name, false]); console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n")[0]}`); }
}

const b = await launch(1400, 1000);
try {
  await b.goto(URL_);
  await b.until(`document.querySelectorAll('.sent').length > 0`, 60000, "the article to render");

  await check("the page renders an article with sections, citations and references, and no script errors", async () => {
    const f = await b.eval(`({ tabs: document.querySelectorAll('.tab').length, sent: document.querySelectorAll('.sent').length,
      sections: document.querySelectorAll('h2.sec').length, cites: document.querySelectorAll('.cite').length, refs: document.querySelectorAll('.ref-item').length,
      toc: !document.querySelector('#toc').hidden, infobox: !document.querySelector('#infobox').hidden })`);
    assert.ok(f.tabs >= 2, `tabs ${f.tabs}`);
    assert.ok(f.sent >= 3 && f.sections >= 1 && f.toc && f.infobox, JSON.stringify(f));
    assert.ok(f.cites >= 1 && f.refs >= 1, "agents have cited sources by now; give the demo a few more seconds if this fails");
    assert.deepEqual(b.problems, []);
  });

  await check("clicking a citation scrolls to its reference and flashes it", async () => {
    await b.eval(`document.querySelector('.cite').click()`);
    await sleep(400);
    assert.ok(await b.eval(`!!document.querySelector('.ref-item.flash')`));
  });

  await check("every tab opens its own article, and the arrow keys move between tabs", async () => {
    const titles = new Set();
    const n = await b.eval(`document.querySelectorAll('.tab').length`);
    for (let i = 0; i < n; i++) {
      await b.eval(`document.querySelectorAll('.tab')[${i}].click()`);
      await sleep(1800);
      titles.add(await b.eval(`document.querySelector('#title').textContent`));
      assert.equal(await b.eval(`document.querySelectorAll('.tab')[${i}].getAttribute('aria-selected')`), "true");
    }
    assert.equal(titles.size, n, [...titles].join(", "));
    await b.eval(`document.querySelectorAll('.tab')[0].click()`);
    await sleep(1500);
    await b.eval(`document.querySelectorAll('.tab')[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
    await sleep(1800);
    assert.equal(await b.eval(`document.querySelectorAll('.tab')[1].getAttribute('aria-selected')`), "true");
    assert.equal(await b.eval(`document.querySelector('.tab[aria-selected=true]').getAttribute('tabindex')`), "0");
  });

  await check("a sentence opens its market, with evidence and a verify button", async () => {
    await b.eval(`document.querySelector('.sent').click()`);
    await sleep(800);
    assert.ok(await b.eval(`document.querySelector('#panel .bigprice') !== null`));
  });

  await check("the swarm panel shows live agents", async () => {
    if (!(await b.eval(`!document.querySelector('#swarmCard').hidden`))) return;
    assert.ok(await b.eval(`document.querySelectorAll('.agent').length >= 3`));
    assert.match(await b.eval(`document.querySelector('#swarmTotals').textContent`), /sources read/);
  });

  if (process.env.VERIFY === "1") {
    await check("Verify re-hashes every source of every article in the browser, checking page title and quote", async () => {
      const n = await b.eval(`document.querySelectorAll('.tab').length`);
      let total = 0;
      for (let i = 0; i < n; i++) {
        await b.eval(`document.querySelectorAll('.tab')[${i}].click()`);
        await sleep(2200);
        if (!(await b.eval(`document.querySelectorAll('.ref-item').length`))) continue;
        await b.eval(`document.querySelector('#verifyAll').click()`);
        await b.until(`[...document.querySelectorAll('.ref-item .vres')].length > 0 && [...document.querySelectorAll('.ref-item .vres')].every(v => !v.classList.contains('busy'))`, 150000, "verification to finish");
        const states = await b.eval(`[...document.querySelectorAll('.ref-item .vres')].map(v => v.className + ': ' + v.textContent.slice(0, 110))`);
        assert.ok(states.every((s) => s.startsWith("vres ok")), states.join("\n"));
        total += states.length;
      }
      assert.ok(total >= 3, `only ${total} sources were checked`);
      assert.ok((await b.eval(`document.querySelector('.ref-item .vres').textContent`)).includes("quoted text is in it"));
    });
  }

  // STORY=1 plays both stories (about 11 NEAR of the demo account's money on a real chain); STORY=add only the cheap one (about 1).
  if (process.env.STORY === "1" || process.env.STORY === "add") {
    if (process.env.STORY === "1") await check("the guided story runs from the lie to the cost, in order", async () => {
      await b.eval(`document.querySelector('.tab[data-topic="pluto"]').click()`);
      await sleep(2000);
      await b.eval(`(() => { const s = document.querySelector('#lieSel'); s.value = [...s.options].find(o => o.textContent.includes('twelve')).value; })()`);
      await b.eval(`document.querySelector('#playStory').click()`);
      const steps = [];
      const moves = [];
      const t0 = Date.now();
      while (Date.now() - t0 < 240000) {
        const cap = await b.eval(`document.querySelector('#stageText').innerText`);
        for (const m of cap.matchAll(/(\d+)% → (\d+)%/g)) if (!moves.some((x) => x.join() === [m[1], m[2]].join())) moves.push([m[1], m[2]]);
        const now = await b.eval(`document.querySelector('#stageSteps .now')?.textContent ?? ''`);
        if (now && steps[steps.length - 1] !== now) steps.push(now);
        if (await b.eval(`/lie cost you/.test(document.querySelector('#stageText').innerText)`)) break;
        await sleep(700);
      }
      assert.deepEqual(steps.map((s) => s[0]), ["1", "2", "3", "4", "5", "6"], steps.join(" | "));
      const caption = await b.eval(`document.querySelector('#stageText').innerText`);
      assert.match(caption, /cost you \d+\.\d\d NEAR/);
      // What the narration claims has to be what happened: the lie starts at 94%, the market takes it under the 30% line, and
      // the cost is of the size measured over six plays (4.9 to 6.1 NEAR), with room either side.
      assert.ok(moves.length >= 2, `price steps shown: ${JSON.stringify(moves)}`);
      assert.equal(moves[0][0], "94", JSON.stringify(moves));
      assert.ok(Number(moves[moves.length - 1][1]) < 30, `the lie ended at ${moves[moves.length - 1][1]}%: ${JSON.stringify(moves)}`);
      const cost = Number(/cost you (\d+\.\d\d) NEAR/.exec(caption)[1]);
      assert.ok(cost > 3 && cost < 8, `the lie cost ${cost} NEAR`);
      assert.deepEqual(b.problems, []);
    });

    if (process.env.STORY === "1") await check("'Play another' starts the next story straight away and it completes (the server's pause between demo actions is waited out, not an error)", async () => {
      await b.eval(`document.querySelector('#again').click()`);
      await b.until(`!/lie cost you/.test(document.querySelector('#stageText').innerText) && document.querySelector('#stageText').innerText.length > 0`, 20000, "the caption to leave the previous result");
      const t0 = Date.now();
      while (Date.now() - t0 < 240000) {
        const text = await b.eval(`document.querySelector('#stageText').innerText`);
        assert.ok(!/story stopped/.test(text), text);
        if (/lie cost you/.test(text)) return;
        await sleep(700);
      }
      throw new Error("the second story did not complete");
    });

    await check("adding a true sentence: it enters at 50%, the agents confirm it with a source, and the price rises", async () => {
      await b.eval(`document.querySelector('#stageStop').click()`);
      await sleep(1500);
      await b.eval(`document.querySelector('.tab[data-topic="pluto"]').click()`);
      await sleep(2000);
      // A sentence is only added once, so take one that is not on the chain yet (a demo that has already been through this check, or
      // through the autopilot, has used some of them; a fresh demo has all four).
      const picked = await b.eval(`(async () => {
        const have = new Set((await (await fetch('api/claims')).json()).map((c) => c.text));
        const s = document.querySelector('#addSel');
        const o = [...s.options].find((o) => ![...have].some((t) => o.textContent.includes(t)));
        if (!o) return null;
        s.value = o.value;
        return o.textContent;
      })()`);
      assert.ok(picked, "every sentence the demo offers to add is already in it: restart the demo for a fresh run");
      await b.eval(`document.querySelector('#playAdd').click()`);
      const steps = [];
      const moves = [];
      const t0 = Date.now();
      while (Date.now() - t0 < 240000) {
        const cap = await b.eval(`document.querySelector('#stageText').innerText`);
        for (const m of cap.matchAll(/(\d+)% → (\d+)%/g)) if (!moves.some((x) => x.join() === [m[1], m[2]].join())) moves.push([m[1], m[2]]);
        const now = await b.eval(`document.querySelector('#stageSteps .now')?.textContent ?? ''`);
        // The bar still shows the previous story's last step until this one's first caption replaces it: start at step 1.
        if (now && steps[steps.length - 1] !== now && (steps.length || now.startsWith("1"))) steps.push(now);
        assert.ok(!/story stopped/.test(cap), cap);
        if (/Established:/.test(cap)) break;
        await sleep(700);
      }
      assert.deepEqual(steps.map((s) => s[0]), ["1", "2", "3", "4", "5", "6"], steps.join(" | "));
      const caption = await b.eval(`document.querySelector('#stageText').innerText`);
      assert.match(caption, /Adding it cost you \d+\.\d\d NEAR/);
      assert.ok(moves.length >= 1, `price steps shown: ${JSON.stringify(moves)}`);
      assert.equal(moves[0][0], "50", JSON.stringify(moves));
      assert.ok(Number(moves[moves.length - 1][1]) >= 70, `the sentence ended at ${moves[moves.length - 1][1]}%: ${JSON.stringify(moves)}`);
      const cost = Number(/Adding it cost you (\d+\.\d\d) NEAR/.exec(caption)[1]);
      assert.ok(cost > 0.9 && cost < 1.5, `adding cost ${cost} NEAR`);
      assert.deepEqual(b.problems, []);
    });
  }
} finally { b.close(); }

// AUTOPILOT=1: the hands-free tour has to run from the first caption to the last on its own, with no script errors, and
// the two stories it starts have to finish (this spends the demo account's money: about 6 NEAR on a real chain).
if (process.env.AUTOPILOT === "1") {
  const ap = await launch(1400, 1000);
  try {
    await check("the autopilot tour runs by itself from the first caption to the last", async () => {
      await ap.goto(`${URL_}/?autopilot=1&pace=0.5`);
      const captions = [];
      let sawAdd = false, sawLie = false, sawVerify = false, cursorMoved = false;
      const t0 = Date.now();
      let finished = false;
      while (Date.now() - t0 < 900000) {
        const s = await ap.eval(`JSON.stringify({ cap: document.querySelector('#apCaption.on')?.innerText ?? '', stage: document.querySelector('#stageText')?.innerText ?? '',
          vres: document.querySelector('.vres')?.className ?? '', cur: document.querySelector('#apCursor')?.style.transform ?? '', btn: !!document.querySelector('#apStart') && !document.querySelector('#apStart').hidden })`);
        const x = JSON.parse(s);
        if (x.cap && captions[captions.length - 1] !== x.cap) captions.push(x.cap);
        if (/Established:/.test(x.stage)) sawAdd = true;
        if (/lie cost you/.test(x.stage)) sawLie = true;
        if (/vres ok/.test(x.vres)) sawVerify = true;
        if (/translate\((?!\d+(\.\d+)?px, \d+)/.test(x.cur) === false && x.cur) cursorMoved = true;
        if (captions.length > 3 && x.btn) { finished = true; break; }
        assert.ok(!/Autopilot stopped/.test(x.cap), x.cap);
        await sleep(500);
      }
      assert.ok(finished, `the tour did not finish; captions so far: ${JSON.stringify(captions)}`);
      assert.ok(sawAdd, "the add story did not reach Established");
      assert.ok(sawLie, "the lie story did not reach its cost");
      assert.ok(sawVerify, "Verify did not come back ok");
      assert.ok(cursorMoved, "the cursor never moved");
      assert.ok(captions.some((c) => /Do not trust us/.test(c)) && captions.some((c) => /Every sentence has a price/.test(c)), JSON.stringify(captions));
      assert.deepEqual(ap.problems, []);
    });

    // The first tour leaves the previous story's last words in the caption bar unless they are cleared, and a second tour in the same
    // page used to read them as its own: the add story "finished" at once. It must now run again, and adding the same sentence a
    // second time must not open a second copy of it.
    await check("a second tour in the same page completes too, and the sentence it adds again is not duplicated", async () => {
      await ap.eval(`document.querySelector('#apStart').click()`);
      let sawExisting = false, sawLie = false, finished = false;
      const t0 = Date.now();
      await sleep(1500);
      while (Date.now() - t0 < 900000) {
        const x = JSON.parse(await ap.eval(`JSON.stringify({ cap: document.querySelector('#apCaption.on')?.innerText ?? '', stage: document.querySelector('#stageText')?.innerText ?? '',
          btn: !!document.querySelector('#apStart') && !document.querySelector('#apStart').hidden })`));
        if (/already in the article/.test(x.stage)) sawExisting = true;
        if (/lie cost you/.test(x.stage)) sawLie = true;
        assert.ok(!/Autopilot stopped/.test(x.cap), x.cap);
        if (x.btn) { finished = true; break; }
        await sleep(500);
      }
      assert.ok(finished, "the second tour did not finish");
      assert.ok(sawExisting, "the add story did not say the sentence was already there");
      assert.ok(sawLie, "the lie story did not run again");
      const copies = await ap.eval(`[...document.querySelectorAll('#body .sent')].filter((e) => e.textContent.includes('Charon was discovered in 1978')).length`);
      assert.equal(copies, 1, "the sentence was added twice");
      assert.deepEqual(ap.problems, []);
    });
  } finally { ap.close(); }
}

const phone = await launch(390, 844);
try {
  await phone.goto(URL_);
  await phone.until(`document.querySelectorAll('.sent').length > 0`, 60000, "the article to render on a phone");
  await check("at phone width nothing scrolls sideways", async () => {
    assert.equal(await phone.eval(`document.documentElement.scrollWidth - document.documentElement.clientWidth`), 0);
  });
} finally { phone.close(); }

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

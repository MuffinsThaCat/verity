#!/usr/bin/env node
/**
 * One command, one video: starts a fresh local demo, opens it in a browser, lets the autopilot tour play, records the page, and
 * writes an MP4.
 *
 *   npm run record                       # -> recordings/verity-demo-<time>.mp4
 *   npm run record:short                 # about two minutes: fits X's 140 seconds for a free account
 *   PACE=1.4 npm run record              # slower captions
 *   SHOW=1 npm run record                # also open the finished video
 *
 * Nothing to click and nothing to start first. It records the browser page itself (Chrome's own screencast of a headless
 * window), not your screen, so you can keep using the computer and nothing of yours ends up in the video. Needs a built project
 * (`npm run build`), Chrome (set CHROME if it is not the macOS default) and ffmpeg. The Verify step fetches Wikipedia live, so it
 * needs the network.
 *
 * Env: PORT (default: a free one), PACE (caption pace, default 1.2), WIDTH/HEIGHT (default 1400x900), AGENT_INTERVAL_MS (default
 * 5000: quicker agents make a shorter video), SETTLE_S (seconds the agents get to move the prices before the tour starts, default
 * 45; not recorded), OUT (output file).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const W = Number(process.env.WIDTH ?? 1400), H = Number(process.env.HEIGHT ?? 900);
// SHORT=1 is for a video that must fit X's 140 seconds for a free account (about two minutes): tighter captions, tighter story
// narration, and agents that react sooner. PACE, SPD and AGENT_INTERVAL_MS still override it.
const SHORT = process.env.SHORT === "1";
const PACE = process.env.PACE ?? (SHORT ? "0.7" : "1.2");
const SPD = process.env.SPD ?? (SHORT ? "0.45" : "1");
const AGENT_MS = process.env.AGENT_INTERVAL_MS ?? (SHORT ? "2500" : "5000");
const SETTLE = Number(process.env.SETTLE_S ?? 45);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(`[record] ${m}`);

if (!existsSync(path.join(root, "dist/scripts/demo.js"))) throw new Error("run `npm run build` first");
if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME=/path/to/chrome`);
if (spawnSync("ffmpeg", ["-version"]).status !== 0) throw new Error("ffmpeg is needed to make the video (brew install ffmpeg)");

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); s.on("error", rej); });
const PORT = Number(process.env.PORT ?? await freePort());
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.resolve(process.env.OUT ?? path.join(root, "recordings", `verity-demo-${stamp}.mp4`));
mkdirSync(path.dirname(out), { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), "verity-rec-"));
const profile = mkdtempSync(path.join(tmpdir(), "verity-rec-chrome-"));

// Frames are written to disk as they arrive (a few hundred MB for a few minutes), so refuse to start on a nearly full disk
// rather than fill it: a full disk breaks everything else running on the machine.
const MIN_FREE_MB = Number(process.env.MIN_FREE_MB ?? 1500);
const freeKb = Number((spawnSync("df", ["-k", work], { encoding: "utf8" }).stdout.trim().split("\n").pop() ?? "").split(/\s+/)[3]);
if (Number.isFinite(freeKb) && freeKb / 1024 < MIN_FREE_MB) {
  rmSync(work, { recursive: true, force: true }); rmSync(profile, { recursive: true, force: true });
  throw new Error(`only ${(freeKb / 1024).toFixed(0)} MB free where frames are kept; free some space (the recording needs about ${MIN_FREE_MB} MB), or set MIN_FREE_MB lower`);
}

let demo = null, chrome = null;
const cleanup = () => {
  // By handle, never by pattern: other projects on a machine can have a script at the same path.
  try { chrome?.kill("SIGKILL"); } catch { /* gone */ }
  try { demo?.kill("SIGINT"); } catch { /* gone */ }
};
// Our own folders only (we made them); the browser's profile is the big leftover if this is skipped. Removed at exit, never
// before the video is encoded: the frames are in `work`.
const tidy = () => {
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on("SIGINT", () => { cleanup(); tidy(); process.exit(130); });
process.on("exit", () => { cleanup(); tidy(); });

// 1. a fresh demo (the path is spelled so that a `pkill -f dist/scripts/demo.js` aimed at another project does not match it)
say(`starting a fresh demo on port ${PORT} ...`);
demo = spawn("node", ["dist/scripts/../scripts/demo.js", "--offline"], {
  cwd: root, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(PORT), DOTENV_CONFIG_PATH: "/dev/null", AGENT_INTERVAL_MS: AGENT_MS },
});
let log = "";
demo.stdout.on("data", (d) => { log += d; });
demo.stderr.on("data", (d) => { log += d; });
const t0 = Date.now();
while (!/demo is live/.test(log)) {
  if (demo.exitCode !== null) throw new Error(`the demo exited early:\n${log.slice(-800)}`);
  if (Date.now() - t0 > 180000) throw new Error(`the demo did not come up in 3 minutes:\n${log.slice(-800)}`);
  await sleep(500);
}
const URL_ = `http://localhost:${PORT}`;
say(`demo is up; letting the agents move the prices for ${SETTLE}s (not recorded) ...`);
await sleep(SETTLE * 1000);

// 2. a browser we can talk to
const dbg = 9400 + Math.floor(Math.random() * 400);
chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--hide-scrollbars", `--window-size=${W},${H}`, "about:blank"], { stdio: "ignore" });
let tabs = [];
for (let i = 0; i < 60 && !tabs.length; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let msgId = 0;
const pending = new Map();
const frames = [];
let frameN = 0;
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++msgId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); }
  else if (msg.method === "Page.screencastFrame") {
    const { data, metadata, sessionId } = msg.params;
    send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    // The video is 30 frames a second, so a frame less than a thirtieth of a second after the last one kept is never seen:
    // dropping it is what keeps the recording small (the page can paint at 60 fps).
    if (frames.length && metadata.timestamp - frames[frames.length - 1].t < 0.033) return;
    const file = path.join(work, `f${String(++frameN).padStart(6, "0")}.jpg`);
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, t: metadata.timestamp });
  }
});
const evalJs = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

// 3. record while the autopilot plays
await send("Page.startScreencast", { format: "jpeg", quality: 82, everyNthFrame: 1 });
say("recording ...");
await send("Page.navigate", { url: `${URL_}/?autopilot=1&pace=${PACE}&spd=${SPD}` });

let captions = 0, last = "", finished = false;
const deadline = Date.now() + 20 * 60 * 1000;
while (Date.now() < deadline) {
  await sleep(1000);
  let s;
  try { s = JSON.parse(await evalJs(`JSON.stringify({ cap: document.querySelector('#apCaption.on')?.innerText ?? '', stage: document.querySelector('#stageText')?.innerText ?? '', btn: !!document.querySelector('#apStart') && !document.querySelector('#apStart').hidden, ready: document.querySelectorAll('.sent').length > 0 })`)); } catch { continue; }
  if (s.cap && s.cap !== last) { last = s.cap; captions++; say(`  ${s.cap.replace(/\s+/g, " ").slice(0, 90)}`); }
  if (/Autopilot stopped/.test(s.cap)) throw new Error(s.cap);
  if (captions > 3 && s.btn) { finished = true; break; }
}
if (!finished) throw new Error("the tour did not finish within 20 minutes");
await sleep(2500); // the closing caption fades
await send("Page.stopScreencast");
await sleep(500);
ws.close();
cleanup();
say(`captured ${frames.length} frames; encoding ...`);

// 4. frames -> video. The screencast sends a frame only when the page changes, so each frame is shown until the next one.
if (frames.length < 10) throw new Error(`only ${frames.length} frames were captured; the page did not render`);
const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, ((frames[i + 1]?.t ?? f.t + 2) - f.t)).toFixed(4)}`).join("\n") + `\nfile '${frames[frames.length - 1].file}'\n`;
writeFileSync(path.join(work, "frames.txt"), list);
const enc = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(work, "frames.txt"),
  "-vf", "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart", out], { encoding: "utf8" });
if (enc.status !== 0) throw new Error(`ffmpeg failed: ${enc.stderr}`);
rmSync(work, { recursive: true, force: true });
const secs = (frames[frames.length - 1].t - frames[0].t).toFixed(0);
say(`done: ${out}  (${secs}s)`);
if (process.env.SHOW === "1") spawn("open", [out], { stdio: "ignore", detached: true }).unref();
process.exit(0);

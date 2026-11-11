import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ActivityTail } from "../src/lib/activity.js";

const line = (o: object) => JSON.stringify({ ts: Date.now(), ...o }) + "\n";

test("the tail reads only what was appended, keeps a partial line until it is finished, and tallies per agent", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "verity-tail-")), "a.jsonl");
  const tail = new ActivityTail(file);
  assert.deepEqual(tail.refresh(), [], "no file yet");
  writeFileSync(file, line({ agent: "R", kind: "scan", text: "s" }) + line({ agent: "R", kind: "source", text: "reading", claimId: 3 }));
  assert.equal(tail.refresh().length, 2);
  assert.equal(tail.refresh().length, 0);
  const half = line({ agent: "R", kind: "trade", text: "bought", claimId: 3 });
  appendFileSync(file, half.slice(0, 20));
  assert.equal(tail.refresh().length, 0, "half a line is not an event");
  appendFileSync(file, half.slice(20) + line({ agent: "S", kind: "evidence", text: "posted" }) + "not json\n" + line({ agent: "R", kind: "error", text: "x" }));
  assert.deepEqual(tail.refresh().map((a) => a.kind), ["trade", "evidence", "error"]);
  const r = tail.agents.get("R")!;
  assert.deepEqual([r.reads, r.trades, r.errors], [1, 1, 1]);
  assert.deepEqual([...r.tradedClaims], [3]);
  assert.equal(r.lastReal!.kind, "error", "the scan line is bookkeeping and never the 'now' line");
  assert.equal(tail.agents.get("S")!.evidence, 1);
});

test("the tail keeps only the most recent events, and starts over if the file shrinks", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "verity-tail-")), "a.jsonl");
  const tail = new ActivityTail(file, 5);
  writeFileSync(file, Array.from({ length: 12 }, (_, i) => line({ agent: "R", kind: "info", text: `t${i}` })).join(""));
  tail.refresh();
  assert.deepEqual(tail.recent.map((a) => a.text), ["t7", "t8", "t9", "t10", "t11"]);
  writeFileSync(file, line({ agent: "R", kind: "trade", text: "fresh" }));
  assert.equal(tail.refresh().length, 1);
  assert.equal(tail.agents.get("R")!.trades, 1);
  assert.equal(tail.agents.get("R")!.reads, 0);
});

test("a read that ends inside a multi-byte character does not corrupt it", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "verity-tail-")), "a.jsonl");
  const tail = new ActivityTail(file);
  const full = Buffer.from(line({ agent: "R", kind: "judge", text: "refute (6%) — \"five known moons\"" }), "utf8");
  const cut = full.indexOf(0xe2) + 1; // inside the three bytes of the em dash
  writeFileSync(file, full.subarray(0, cut));
  assert.equal(tail.refresh().length, 0);
  appendFileSync(file, full.subarray(cut));
  const [a] = tail.refresh();
  assert.equal(a!.text, "refute (6%) — \"five known moons\"");
});

test("a very large file is not read whole on a restart: the tail starts near the end, at a line break", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "verity-tail-")), "big.jsonl");
  let text = "";
  for (let i = 0; i < 400; i++) text += line({ agent: "A", kind: "trade", claimId: i, text: `event ${i}` });
  writeFileSync(file, text);
  const tail = new ActivityTail(file, 600, 3_000);
  const fresh = tail.refresh();
  assert.ok(fresh.length > 5 && fresh.length < 100, `read ${fresh.length} events`);
  assert.equal(fresh[fresh.length - 1]!.text, "event 399");
  assert.ok(fresh.every((a) => /^event \d+$/.test(a.text)), "no event is a torn half-line");
  appendFileSync(file, line({ agent: "A", kind: "trade", claimId: 400, text: "event 400" }));
  assert.deepEqual(tail.refresh().map((a) => a.text), ["event 400"]);
});

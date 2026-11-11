import { appendFileSync, mkdirSync, existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { redactSecrets } from "./log.js";

/** One thing an agent did or decided. Written as JSON lines so the server can stream them to the UI. */
export interface Activity {
  ts: number;
  agent: string;
  kind: "scan" | "source" | "judge" | "evidence" | "trade" | "arb" | "settle" | "skip" | "error" | "info";
  claimId?: number;
  text: string;
  data?: Record<string, unknown>;
}

export interface ActivitySink {
  emit(a: Omit<Activity, "ts">): void;
}

export class FileActivity implements ActivitySink {
  constructor(private readonly file: string, private readonly echo = true) {
    mkdirSync(path.dirname(file), { recursive: true });
  }
  emit(a: Omit<Activity, "ts">) {
    const rec: Activity = { ts: Date.now(), ...a, text: redactSecrets(a.text) };
    appendFileSync(this.file, JSON.stringify(rec) + "\n");
    if (this.echo) console.log(`${new Date(rec.ts).toISOString().slice(11, 19)} [${a.agent}] ${a.text}`);
  }
}

export class MemoryActivity implements ActivitySink {
  readonly items: Activity[] = [];
  emit(a: Omit<Activity, "ts">) {
    this.items.push({ ts: Date.now(), ...a });
  }
}

export function readActivity(file: string, limit = 200): Activity[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const out: Activity[] = [];
  for (const l of lines.slice(-limit)) {
    try { out.push(JSON.parse(l) as Activity); } catch { /* skip a torn line */ }
  }
  return out;
}

export interface AgentCounts {
  /** Sources read, verdicts judged, evidence posted, trades made, arbitrage legs found. */
  reads: number;
  judged: number;
  evidence: number;
  trades: number;
  errors: number;
  last: Activity | null;
  /** Last event that says what the agent is doing, skipping bookkeeping lines. */
  lastReal: Activity | null;
  /** Claims this agent has traded, so its positions can be valued without scanning the whole market. */
  tradedClaims: Set<number>;
}

/**
 * Follows the activity file by byte offset, so a long run is read once rather than on every request. Keeps the most
 * recent events and a running tally per agent.
 */
export class ActivityTail {
  private offset = 0;
  private partial = "";
  // A read can end in the middle of a multi-byte character ("—" is in every judge line); the decoder holds the rest back.
  private decoder = new StringDecoder("utf8");
  readonly recent: Activity[] = [];
  readonly agents = new Map<string, AgentCounts>();

  constructor(private readonly file: string, private readonly keep = 600, private readonly maxFirstRead = 8_000_000) {}

  /** Reads whatever was appended since the last call. Returns the new events. */
  refresh(): Activity[] {
    if (!existsSync(this.file)) return [];
    const size = statSync(this.file).size;
    if (size < this.offset) { this.offset = 0; this.partial = ""; this.decoder = new StringDecoder("utf8"); this.recent.length = 0; this.agents.clear(); }
    if (size === this.offset) return [];
    // A file that has grown for weeks is not read into memory whole on a restart: start near the end, at a line break.
    let skipPartial = false;
    if (this.offset === 0 && size > this.maxFirstRead) { this.offset = size - this.maxFirstRead; skipPartial = true; }
    const fd = openSync(this.file, "r");
    let text: string;
    try {
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      text = this.decoder.write(buf);
    } finally { closeSync(fd); }
    this.offset = size;
    if (skipPartial) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
    const lines = (this.partial + text).split("\n");
    this.partial = lines.pop() ?? "";
    const fresh: Activity[] = [];
    for (const l of lines) {
      if (!l) continue;
      try { fresh.push(JSON.parse(l) as Activity); } catch { /* skip a torn line */ }
    }
    for (const a of fresh) this.tally(a);
    this.recent.push(...fresh);
    if (this.recent.length > this.keep) this.recent.splice(0, this.recent.length - this.keep);
    return fresh;
  }

  private tally(a: Activity) {
    let c = this.agents.get(a.agent);
    if (!c) { c = { reads: 0, judged: 0, evidence: 0, trades: 0, errors: 0, last: null, lastReal: null, tradedClaims: new Set() }; this.agents.set(a.agent, c); }
    c.last = a;
    if (a.kind === "source") c.reads++;
    else if (a.kind === "judge") c.judged++;
    else if (a.kind === "evidence") { if (!a.data?.reused) c.evidence++; }
    else if (a.kind === "trade") { c.trades++; if (a.claimId !== undefined) c.tradedClaims.add(a.claimId); }
    else if (a.kind === "error") c.errors++;
    if (a.kind !== "scan") c.lastReal = a;
  }
}

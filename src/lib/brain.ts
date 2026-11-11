import { cpSync, existsSync } from "node:fs";
import path from "node:path";
import { CachedJudge, LLMJudge, type Judge } from "./judge.js";
import { makeLLM, type LLM } from "./llm.js";
import { OfflineJudge } from "./offlineJudge.js";
import { CachedProvider, StaticProvider, WikipediaProvider, type SourceProvider } from "./sources.js";
import { plutoCorpus } from "../demo/corpus.js";

export interface Brain {
  llm: LLM | null;
  judge: Judge;
  sources: SourceProvider;
  /** True when the judge is a rule-based stand-in. The UI says so out loud. */
  mock: boolean;
  judgeLabel: string;
  sourcesLabel: string;
}

let warnedAboutAgent = false;

/**
 * The repository ships the pages the demo reads (`seed-cache/`, Wikipedia text under CC BY-SA, see its README). Whatever of it
 * the cache directory lacks is copied in (never over a file that is already there), so the offline demo works on a fresh clone
 * without `npm run warm`, and a cache left half-filled by an interrupted warm is completed rather than ignored.
 */
function seedCache(dir: string) {
  const shipped = path.resolve("seed-cache");
  if (existsSync(path.join(shipped, "q"))) cpSync(shipped, dir, { recursive: true, force: false, errorOnExist: false, filter: (src) => !src.endsWith("README.md") });
}
/** Real Wikipedia, remembered on disk: a pinned revision names fixed content, so a page is fetched once. */
export function wikipedia(): SourceProvider {
  if (!process.env.VERITY_USER_AGENT && process.env.VERITY_CACHE_ONLY !== "1" && !warnedAboutAgent) {
    warnedAboutAgent = true;
    console.warn("[verity] VERITY_USER_AGENT is not set. Wikimedia asks automated clients to identify themselves with a real contact, and limits those that do not. Set VERITY_USER_AGENT='VerityBot/1.0 (you@example.org)'.");
  }
  const dir = process.env.VERITY_CACHE_DIR ?? path.resolve("data/cache");
  seedCache(dir);
  return new CachedProvider(new WikipediaProvider(), dir, { offline: process.env.VERITY_CACHE_ONLY === "1" });
}

/**
 * Three modes, selected by env vars:
 *
 * 1. VERITY_MOCK=1  →  rule-based judge + a tiny static corpus (tests, no network)
 * 2. No API key     →  rule-based judge + real Wikipedia (the demo without spending money)
 * 3. API key set    →  LLM judge + real Wikipedia
 *
 * Mode 2 reads real pinned Wikipedia revisions and hashes them (so `curl | shasum` works), but the judge matches words
 * and figures; it is not a model. The UI labels it "rule-based judge" so nobody mistakes it for a language model.
 * `VERITY_CACHE_ONLY=1` answers from the on-disk cache alone (run `npm run warm` first).
 */
export function makeBrain(): Brain {
  const llm = makeLLM();

  if (process.env.VERITY_MOCK === "1") {
    return {
      llm, judge: new OfflineJudge("MOCK-static-judge"), sources: new StaticProvider(plutoCorpus()), mock: true,
      judgeLabel: "MOCK rule-based judge (static corpus)", sourcesLabel: "MOCK static corpus",
    };
  }

  if (llm) {
    return {
      llm, judge: new CachedJudge(new LLMJudge(llm)), sources: wikipedia(), mock: false,
      judgeLabel: `LLM judge (${llm.name})`, sourcesLabel: "Wikipedia, pinned revisions",
    };
  }

  return {
    llm: null, judge: new CachedJudge(new OfflineJudge()), sources: wikipedia(), mock: true,
    judgeLabel: "rule-based judge (no model)", sourcesLabel: "Wikipedia, pinned revisions",
  };
}

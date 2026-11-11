import { z } from "zod";

/** A language model that must answer with JSON matching a schema. Anything else comes back as null. */
export interface LLM {
  readonly name: string;
  /** How the model has been answering: calls that returned nothing usable are failures, and `last` says why. */
  health?(): { calls: number; failures: number; last: string | null };
  json<T>(o: { system: string; user: string; schema: z.ZodType<T>; maxTokens?: number }): Promise<T | null>;
}

type FetchFn = typeof fetch;

export function extractJson(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

async function postJson(fetchFn: FetchFn, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetchFn(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

abstract class BaseLLM implements LLM {
  abstract readonly name: string;
  protected abstract ask(system: string, user: string, maxTokens: number): Promise<string | null>;
  private calls = 0;
  private failures = 0;
  private last: string | null = null;
  /** Why the latest request failed (the HTTP status, an error, an unusable answer). Set by `ask`. */
  protected why: string | null = null;

  health() { return { calls: this.calls, failures: this.failures, last: this.last }; }

  async json<T>(o: { system: string; user: string; schema: z.ZodType<T>; maxTokens?: number }): Promise<T | null> {
    const system = `${o.system}\n\nReply with a single JSON object and nothing else.`;
    this.calls++;
    let why = "no answer";
    for (let attempt = 0; attempt < 2; attempt++) {
      let text: string | null = null;
      this.why = null;
      try { text = await this.ask(system, o.user, o.maxTokens ?? 1200); } catch (e) { text = null; this.why = e instanceof Error ? e.message.split("\n")[0]! : String(e); }
      if (!text) { why = this.why ?? "empty answer"; continue; }
      const parsed = o.schema.safeParse(extractJson(text));
      if (parsed.success) return parsed.data;
      why = "the answer was not the JSON that was asked for";
    }
    this.failures++;
    if (this.last === null) console.warn(`[verity] the language model returned nothing usable: ${why}. Verdicts will be empty until this is fixed (key, model name, quota?).`);
    this.last = why;
    return null;
  }
}

export class AnthropicLLM extends BaseLLM {
  readonly name: string;
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = "https://api.anthropic.com",
    private readonly fetchFn: FetchFn = fetch,
  ) {
    super();
    this.name = `anthropic:${model}`;
  }
  protected async ask(system: string, user: string, maxTokens: number) {
    const res = await postJson(
      this.fetchFn, `${this.baseUrl}/v1/messages`,
      { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      { model: this.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] },
      60_000,
    );
    if (!res.ok) { this.why = `HTTP ${res.status} from ${this.baseUrl}`; return null; }
    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return body.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("") ?? null;
  }
}

/** Any OpenAI-compatible chat endpoint, for example a NEAR AI Cloud deployment or a local server. */
export class OpenAICompatLLM extends BaseLLM {
  readonly name: string;
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    super();
    this.name = `openai-compat:${model}`;
  }
  protected async ask(system: string, user: string, maxTokens: number) {
    const res = await postJson(
      this.fetchFn, `${this.baseUrl.replace(/\/$/, "")}/chat/completions`,
      { authorization: `Bearer ${this.apiKey}` },
      { model: this.model, max_tokens: maxTokens, messages: [{ role: "system", content: system }, { role: "user", content: user }] },
      60_000,
    );
    if (!res.ok) { this.why = `HTTP ${res.status} from ${this.baseUrl}`; return null; }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return body.choices?.[0]?.message?.content ?? null;
  }
}

/** `VERITY_LLM=off` disables it. Otherwise: Anthropic if a key is set, else an OpenAI-compatible endpoint, else none. */
export function makeLLM(): LLM | null {
  if ((process.env.VERITY_LLM ?? "auto") === "off") return null;
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) return new AnthropicLLM(key, process.env.VERITY_MODEL ?? "claude-sonnet-5-5", process.env.ANTHROPIC_BASE_URL);
  if (process.env.LLM_BASE_URL && process.env.LLM_API_KEY) {
    return new OpenAICompatLLM(process.env.LLM_BASE_URL, process.env.LLM_API_KEY, process.env.LLM_MODEL ?? "default");
  }
  return null;
}

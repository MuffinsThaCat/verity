import { test } from "node:test";
import assert from "node:assert/strict";
import { Chain, isRateLimited } from "../src/lib/chain.js";
import { redactSecrets } from "../src/lib/log.js";

test("an RPC key never survives in an error text, however the address is written", () => {
  assert.equal(redactSecrets("fetch failed: https://rpc.testnet.fastnear.com/?apiKey=abc123def&x=1"), "fetch failed: https://rpc.testnet.fastnear.com/?apiKey=[hidden]&x=1");
  assert.equal(redactSecrets("GET https://h.example/rpc?token=s3cret failed"), "GET https://h.example/rpc?token=[hidden] failed");
  assert.equal(redactSecrets("connect https://user:p4ss@rpc.example.org/x"), "connect https://[hidden]@rpc.example.org/x");
  assert.equal(redactSecrets("Authorization: Bearer abcdef0123456789"), "Authorization: Bearer [hidden]");
  assert.equal(redactSecrets("claim 429 not found at https://rpc.example.org/"), "claim 429 not found at https://rpc.example.org/", "nothing secret, nothing changed");
});

const chainWith = (callFunction: () => Promise<unknown>) => {
  const c = new Chain("a.testnet", undefined, "verity.testnet", "http://127.0.0.1:1");
  (c as unknown as { account: unknown }).account = { provider: { callFunction } };
  return c;
};

test("a provider's rate limit is recognised however it is worded", () => {
  assert.ok(isRateLimited(Object.assign(new Error("Request failed"), { cause: 429 })));
  assert.ok(isRateLimited(new Error('{"jsonrpc": "2.0", "error": {"code": -429, "message": "Rate limits exceeded."}}')));
  assert.ok(isRateLimited(new Error("Rate limit of your project plan exceeded")));
  assert.ok(isRateLimited(new Error("HTTP 429 Too Many Requests")));
  assert.ok(!isRateLimited(new Error("account does not exist")));
  assert.ok(!isRateLimited(new Error("Smart contract panicked: claim 4290 not found")));
  assert.ok(!isRateLimited(new Error("Smart contract panicked: claim 429 not found")), "a bare 429 is a claim id, not a limit");
  assert.ok(!isRateLimited(new Error("account verity429.testnet does not exist")));
  assert.ok(!isRateLimited(new Error("claim_id 429: no such claim")));
  assert.ok(isRateLimited(new Error("The faucet server failed with status code <429 Too Many Requests>")));
  assert.ok(!isRateLimited(null));
});

test("the balance read is retried too: every demo action starts with it", async () => {
  let calls = 0;
  const c = new Chain("a.testnet", undefined, "verity.testnet", "http://127.0.0.1:1");
  (c as unknown as { account: unknown }).account = { getBalance: async () => { if (++calls < 2) throw new Error("code -429 Rate limit"); return 5n; } };
  assert.equal(await c.balance(), 5n);
  assert.equal(calls, 2);
});

test("a read that is rate limited is retried and then succeeds; any other error is not retried", async () => {
  let calls = 0;
  const flaky = chainWith(async () => { if (++calls < 3) throw new Error("code -429 Rate limits exceeded"); return { ok: true }; });
  assert.deepEqual(await flaky.view("get_config"), { ok: true });
  assert.equal(calls, 3);

  let other = 0;
  const broken = chainWith(async () => { other++; throw new Error("account does not exist"); });
  await assert.rejects(broken.view("get_config"), /does not exist/);
  assert.equal(other, 1, "a real failure is reported at once");
});

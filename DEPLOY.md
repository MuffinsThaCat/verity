# Deploying to testnet

These steps have been run once, end to end, against NEAR testnet (2026-11-08): `bootstrap`, `split-env`, `check-code` (MATCH), `seed`,
`agents` and `server` all worked as written. What that run showed:

- **Use a keyed RPC.** The free `rpc.testnet.fastnear.com` rate-limits (HTTP 429) three agents and a server within a minute, and the deprecated
  `rpc.testnet.near.org` is worse. Get a key at dashboard.fastnear.com and set `NEAR_RPC_URL=https://rpc.testnet.fastnear.com?apiKey=...` in the
  environment of the processes (not in a file you commit). `/api/config` shows the address without the key. Reads are retried with backoff on a
  429; writes are not retried blindly, since a 429 can arrive after a transaction was accepted.
- **Agents spend their own NEAR.** Three agents on four articles used about 10 NEAR each in the first ten minutes (positions they never sell,
  plus bonds). Budget for that, or follow one article (`AGENT_TOPICS=pluto`).
- **The faucet is rate limited.** It gave 10 NEAR per account, nine times in a row, then answered 429 for hours.
- `scripts/testnet-demo.sh start|stop|status` runs the server (with the demo controls) and the agents with these settings.

## 1. Build

```bash
npm install
npm run build:contract     # needs the pinned toolchain; res/verity.wasm is already built if you want to skip this
npm run test:contract
npm run build
```

`build.sh` pins Rust 1.86 and `near-sdk =5.9.0` because newer compilers emit WASM features NEAR's VM may reject, and then
validates the result with `wasm-tools` (baseline WASM plus sign-extension only). Do not bump `near-sys` in `Cargo.lock`.

## 2. Accounts and contract

You need one funded testnet account with its private key. It pays for everything below (about 100 NEAR with the defaults: 60
for the editor, 10 for each agent, 6 for the contract; set `AGENT_FUND_NEAR`, `EDITOR_FUND_NEAR`, `CONTRACT_FUND_NEAR` to change it).

```bash
export ADMIN_ACCOUNT_ID=yourname.testnet
export ADMIN_PRIVATE_KEY=ed25519:...
export PREFIX=verity1                 # must be fresh: an existing account would have no key we know
npm run bootstrap
```

It creates `verity1-contract.<admin>` and four funded sub-accounts (researcher, skeptic, arbiter, editor), deploys
`verity.wasm`, calls `new` (bond window 1 hour, fee 1%; set `BOND_WINDOW_SECS` and `FEE_BPS` first to change them, since both are fixed at deployment), and writes `.env.generated` with mode 600, adding each account's key the moment the account exists (so a failure part-way leaves the keys of whatever was funded) and including the contract account's own as `CONTRACT_PRIVATE_KEY`. It refuses to run if `.env.generated` already exists, so keys from an earlier run are never overwritten. Then run `npm run split-env`. It turns `.env.generated` into the three files a deployment uses, with mode 600 and without
overwriting anything that exists: `.env.agents` (network, contract and the researcher, skeptic and arbiter accounts with their keys),
`.env.server` (network, contract and those three accounts' ids only) and `.env` (network, contract and the editor account, which
`npm run seed` and `npm run verify-evidence` read). The server never signs for the agents, so it should not hold their keys. The
`CONTRACT_*` lines go into none of them: the contract account's full-access key is only for upgrading the contract or deleting that
key, nothing in the server or the agents reads it, and it has no business in the environment of a long-running process. Keep it
somewhere safe, or delete the key on the account to make the contract immutable. Set `VERITY_USER_AGENT` to something with a real contact in `.env.agents` (the agents are the main Wikipedia client, and a shell `export` does
not reach an agent started elsewhere) and in `.env.server`. Add `ANTHROPIC_API_KEY` (or the `LLM_*` variables) to
`.env.agents`, and to `.env.server` too if you want the model to write the ledes, which means the server then holds that key. NEAR keys are
ed25519, imposed by the platform.

### Is the deployed code the file in this repository?

`npm run check-code` prints the sha256 of `contracts/verity/res/verity.wasm` and the base58 form NEAR calls its code hash. With
`VERITY_CONTRACT=<account>` set it also reads the code hash from the chain and says MATCH or DIFFERENT. The build is not reproducible
(`build.sh` says why), so this cannot show that the wasm was built from `src/lib.rs`; it shows that what is deployed is exactly the
file you can inspect and hash yourself.

## 3. Seed, run

```bash
npm run seed                         # every article in seed/; links may point across articles, so seed them together (refuses a contract that already has claims; `npm run seed -- --force` to override, the `--` is needed)
export VERITY_USER_AGENT='VerityBot/1.0 (you@example.org)'   # for this shell's `npm run warm`; Wikimedia asks for a real contact
npm run warm                          # optional: cache the pages the seed claims need
DOTENV_CONFIG_PATH=.env.agents npm run agents   # researcher, skeptic, arbiter loop (holds the agents' keys)
DOTENV_CONFIG_PATH=.env.server npm run server   # UI on :8787 (account ids only, no keys)
npm run verify-evidence               # audit every recorded hash against the live source
```

`SEED_NEAR` is the pool depth per claim (default 1). A smaller run, if testnet NEAR is scarce: `SEED_NEAR=0.5 EDITOR_FUND_NEAR=20 npm run bootstrap` and `SEED_NEAR=0.5 npm run seed` need about 56 NEAR in all (6 for the contract, 10 for each agent, 20 for the editor), at the price of pools that are easy to push around. Seeding all four articles (23 claims and one link) costs about 26 NEAR at
`SEED_NEAR=1` and about 50 at 2, and the script checks the editor's balance first and refuses to start if it cannot finish. Deeper pools are harder to push around, which is the whole security budget of a
perpetual market; on testnet, 1 to 2 NEAR is a reasonable demo depth with the default funding (the editor gets 60 NEAR, and depth 3 needs about 72: raise `EDITOR_FUND_NEAR` to go deeper).

## 4. Public deployment notes

- Leave `DEMO_ENABLED` unset on anything public, or point it at a throwaway funded account: it lets any visitor spend that
  account's NEAR.
- The server holds no keys unless demo controls are on, provided you give it its own env file (`.env.server`, no `*_PRIVATE_KEY` lines). If you run it from the one `.env` that also has the agents' keys, they are in its environment although it never uses them. The agents hold their own keys; run them where you would run any bot.
- `/api/verify` refetches evidence for the page's fallback check. It only contacts hosts in `VERITY_VERIFY_HOSTS` (default `wikipedia.org`),
  because the contract accepts any `http://` evidence URI. Do not widen the list casually.
- The swarm panel appears when `RESEARCHER_ACCOUNT_ID`, `SKEPTIC_ACCOUNT_ID` or `ARBITER_ACCOUNT_ID` are set for the server.
- The page uses relative URLs, so it works under a path prefix (`https://host/verity/`) as long as the proxy strips the prefix and
  the page is opened under that prefix (an address without the trailing `/` is redirected to one by the page itself). The server answers `/api/*`, `/lib/wikitext.js` and the files in `web/`.
- Behind a reverse proxy, set `TRUST_PROXY=1` so the per-visitor request limit counts the address the proxy saw (the last `X-Forwarded-For` entry), not the proxy's own; without it every visitor shares one allowance. Set it only when the proxy overwrites or appends that header itself.
- To show the demo controls (add a true sentence, lie to the encyclopedia) on a deployed contract, give the server `DEMO_ENABLED=1`, `DEMO_ACCOUNT_ID` and `DEMO_PRIVATE_KEY` of a throwaway funded account (the editor works; a sentence costs about 1 NEAR, a lie about 5), and keep `seed/` next to it: the server finds the seed claims on the chain by topic and text, so it works on a contract seeded in an earlier run. Only articles the agents follow (`AGENT_TOPICS`) get checked, so give the server the same `AGENT_TOPICS` as the agents and it will offer only those articles' sentences and lies (`scripts/testnet-demo.sh` does this). A sentence is only added once: adding it again answers with the existing claim instead of opening a copy. Pass the key on the command line rather than putting it in `.env.server`.
- The server follows the first 24 articles created (`VERITY_MAX_ARTICLES`), or exactly the ones named in `VERITY_ARTICLES=pluto,mount-everest`. Anyone can open a claim under a new article name for a fraction of a NEAR, and every article costs the node calls on every poll, so later articles are not shown unless you list them; `/api/config` reports how many are hidden.
- The server is a single Node process (`dist/src/server.js`) that serves `web/` and the JSON API. Put it behind any reverse proxy.
- To make the contract immutable, delete the full-access key on the contract account after deploying. There is no admin
  function in the contract.

## 5. Mainnet

Not recommended without a review of DESIGN.md's limits table. Collateral is native NEAR, pools can be moved by anyone with
money, and a judge model can be wrong.

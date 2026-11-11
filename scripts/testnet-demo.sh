#!/usr/bin/env bash
# Runs the deployed (testnet) Verity: the server with the demo controls on, and the agents.
#
#   FASTNEAR_KEY=... scripts/testnet-demo.sh start     # then open http://localhost:8788
#   scripts/testnet-demo.sh status                     # balances and recent activity
#   scripts/testnet-demo.sh stop
#
# Needs `npm run build`, and the env files `npm run bootstrap` + `npm run split-env` wrote (.env, .env.agents, .env.server).
# FASTNEAR_KEY is a key from dashboard.fastnear.com. Without it the free RPC rate-limits the agents within a minute.
# The key is passed to the two processes in their environment only; nothing is written to a file.
# The demo account is the editor account from .env: it pays for the sentences and lies visitors add (about 1 and 5 NEAR).
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8788}"   # 8787 is the local sandbox demo's port
mkdir -p data

env_of() { grep "^$1=" "$2" | head -1 | cut -d= -f2-; }

# Stops only the processes this script started, by the pids it wrote down. (A pattern kill such as `pkill -f dist/src/server.js`
# would also take down any other project on the machine that has a file at the same path.)
stop() {
  for f in data/server.pid data/agents.pid; do
    [ -f "$f" ] || continue
    pid="$(cat "$f")"
    # Only if that pid is still one of ours: a stale file must never point at some other process that reused the number.
    if ps -p "$pid" -o command= 2>/dev/null | grep -q "node dist/src/"; then kill "$pid" 2>/dev/null || true; fi
    rm -f "$f"
  done
}

case "${1:-}" in
  start)
    [ -f .env ] && [ -f .env.agents ] && [ -f .env.server ] || { echo "missing .env / .env.agents / .env.server: run npm run bootstrap && npm run split-env"; exit 1; }
    [ -n "${FASTNEAR_KEY:-}" ] || { echo "set FASTNEAR_KEY (dashboard.fastnear.com), or expect 429s from the free RPC"; exit 1; }
    stop; sleep 2
    export NEAR_RPC_URL="https://rpc.testnet.fastnear.com?apiKey=$FASTNEAR_KEY"
    export VERITY_USER_AGENT="${VERITY_USER_AGENT:-VerityBot/1.0 (NEAR hackathon demo; set VERITY_USER_AGENT to a real contact)}"
    # The agents follow one article by default (the stories run on Pluto), which keeps them inside the RPC key's budget;
    # AGENT_TOPICS=pluto,apollo-11 widens it, and AGENT_TOPICS= (empty) means every article. The server gets the same list so
    # it offers only the sentences and lies the agents will look at.
    topics="${AGENT_TOPICS-pluto}"
    PORT="$PORT" DEMO_ENABLED=1 DEMO_ACCOUNT_ID="$(env_of EDITOR_ACCOUNT_ID .env)" DEMO_PRIVATE_KEY="$(env_of EDITOR_PRIVATE_KEY .env)" \
      DEMO_HOURLY_BUDGET_NEAR="${DEMO_HOURLY_BUDGET_NEAR:-12}" VERITY_POLL_MS="${VERITY_POLL_MS:-8000}" AGENT_TOPICS="$topics" \
      DOTENV_CONFIG_PATH=.env.server nohup node dist/src/server.js > data/server.log 2>&1 &
    echo $! > data/server.pid
    AGENT_TOPICS="$topics" AGENT_INTERVAL_MS="${AGENT_INTERVAL_MS:-30000}" AGENT_MAX_TRADE_NEAR="${AGENT_MAX_TRADE_NEAR:-1}" \
      DOTENV_CONFIG_PATH=.env.agents nohup node dist/src/agents/run.js > data/agents.log 2>&1 &
    echo $! > data/agents.pid
    sleep 20
    echo "server: http://localhost:$PORT   (logs: data/server.log, data/agents.log)"
    curl -s "localhost:$PORT/api/config" | head -c 160; echo
    ;;
  stop) stop; echo stopped ;;
  status)
    rpc="https://rpc.testnet.fastnear.com${FASTNEAR_KEY:+?apiKey=$FASTNEAR_KEY}"
    for r in RESEARCHER SKEPTIC ARBITER; do
      id="$(env_of ${r}_ACCOUNT_ID .env.agents)"
      printf "%-10s " "$r"
      curl -s -X POST "$rpc" -H 'content-type: application/json' \
        -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$id\"}}" \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(Number(BigInt(JSON.parse(s).result.amount)/10n**20n)/1e4,"NEAR")}catch{console.log("unreadable (rate limited?)")}})'
    done
    echo "429s in the agents' log: $(grep -c 429 data/agents.log 2>/dev/null || true)"
    tail -3 data/agents.log 2>/dev/null | cut -c1-160
    ;;
  *) echo "usage: [FASTNEAR_KEY=...] $0 start|stop|status"; exit 2 ;;
esac

#!/usr/bin/env bash
# Builds contracts/verity/res/verity.wasm in a form NEAR's VM accepts.
#
# Preferred path: `cargo near build non-reproducible-wasm` (https://github.com/near/cargo-near) if installed.
# Fallback path (what this script does itself):
#   1. build with the pinned toolchain and the baseline WASM CPU
#   2. re-encode canonically (wasm-opt if present, otherwise a wabt round trip) so precompiled std code
#      does not carry newer encodings
#   3. validate against baseline WASM + sign-extension with wasm-tools, and refuse to ship if it fails
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p res

if command -v cargo-near >/dev/null 2>&1; then
  cargo near build non-reproducible-wasm
  cp target/near/verity.wasm res/verity.wasm 2>/dev/null || cp target/near/*/verity.wasm res/verity.wasm
  ls -la res/verity.wasm
  shasum -a 256 res/verity.wasm 2>/dev/null || sha256sum res/verity.wasm
  exit 0
fi

RUSTFLAGS="-C target-cpu=mvp" cargo build --target wasm32-unknown-unknown --release
RAW=target/wasm32-unknown-unknown/release/verity.wasm

if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz --signext-lowering "$RAW" -o res/verity.wasm
else
  # wasm-tools alone is enough: print the module as text and parse it back, which writes it out in canonical encoding.
  command -v wasm-tools >/dev/null 2>&1 || { echo "Need binaryen (wasm-opt), wasm-tools, or cargo-near to normalise the WASM." >&2; exit 1; }
  TMP="$(mktemp -d)"
  wasm-tools strip -a "$RAW" -o "$TMP/stripped.wasm"
  wasm-tools print "$TMP/stripped.wasm" -o "$TMP/m.wat"
  wasm-tools parse "$TMP/m.wat" -o res/verity.wasm
  rm -rf "$TMP"
fi

if command -v wasm-tools >/dev/null 2>&1; then
  wasm-tools validate --features mvp,sign-extension res/verity.wasm
  echo "validated: baseline WASM + sign-extension only"
fi
ls -la res/verity.wasm
# The build is not reproducible, so this hash cannot show the file came from the source; `npm run check-code` compares it with a deployed contract.
shasum -a 256 res/verity.wasm 2>/dev/null || sha256sum res/verity.wasm

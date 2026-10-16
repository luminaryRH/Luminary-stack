#!/usr/bin/env bash
# Regenerates the UltraHonk verification keys and Solidity verifiers from the compiled circuits (run in WSL from
# circuits/, after `nargo compile --workspace`). Never hand-edit the generated verifiers.
set -euo pipefail
# Toolchain of record: the verifiers on chain were generated with exactly these versions.
NARGO_VERSION="1.0.0-beta.22"
BB_VERSION="5.0.0-nightly.20260522"
BB=${BB:-$HOME/.bb/bb}
nargo --version | grep -q "nargo version = $NARGO_VERSION" || { echo "need nargo $NARGO_VERSION (noirup -v $NARGO_VERSION)"; exit 1; }
"$BB" --version | grep -q "$BB_VERSION" || { echo "need bb $BB_VERSION (bbup -v $BB_VERSION)"; exit 1; }
OUT=../contracts/src/verifiers
declare -A NAME=([deposit]=Deposit [tree_update]=TreeUpdate [transact]=Transact [order_validity]=OrderValidity [reclaim]=Reclaim [rfq_cross]=RfqCross [auction_clear]=AuctionClear)
for c in "${!NAME[@]}"; do
  mkdir -p "target/$c"
  "$BB" write_vk -b "target/$c.json" -o "target/$c" -t evm >/dev/null
  "$BB" write_solidity_verifier -k "target/$c/vk" -o "$OUT/${NAME[$c]}Verifier.sol" -t evm >/dev/null
  # a fixed pragma on every deployable contract (the generator writes a floating one)
  sed -i -E 's/^pragma solidity [^;]+;/pragma solidity 0.8.28;/' "$OUT/${NAME[$c]}Verifier.sol"
  echo "$c -> ${NAME[$c]}Verifier.sol"
done

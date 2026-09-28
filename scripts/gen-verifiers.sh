#!/usr/bin/env bash
# Regenerates the UltraHonk verification keys and Solidity verifiers from the compiled circuits (run in WSL from
# circuits/, after `nargo compile --workspace`). Never hand-edit the generated verifiers.
set -euo pipefail
BB=/home/powerz/.bb/bb
OUT=../contracts/src/verifiers
declare -A NAME=([deposit]=Deposit [tree_update]=TreeUpdate [transact]=Transact [order_validity]=OrderValidity [reclaim]=Reclaim [rfq_cross]=RfqCross [auction_clear]=AuctionClear)
for c in "${!NAME[@]}"; do
  mkdir -p "target/$c"
  "$BB" write_vk -b "target/$c.json" -o "target/$c" -t evm >/dev/null
  "$BB" write_solidity_verifier -k "target/$c/vk" -o "$OUT/${NAME[$c]}Verifier.sol" -t evm >/dev/null
  echo "$c -> ${NAME[$c]}Verifier.sol"
done

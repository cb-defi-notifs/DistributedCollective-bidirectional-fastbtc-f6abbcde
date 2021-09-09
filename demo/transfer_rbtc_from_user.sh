#!/bin/bash
set -e
cd "$(dirname "$0")"
THIS_DIR=$(pwd)

USER_PRIVATE_KEY=$(jq -r '.user.privateKey' test_accounts.json)

cd ../packages/fastbtc-contracts
npx hardhat --network localhost transfer-rbtc-to-btc $USER_PRIVATE_KEY 1foo 1.23
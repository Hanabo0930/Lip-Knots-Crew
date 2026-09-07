#!/usr/bin/env bash
set -euo pipefail

# 出力先が別の2アプリだけを並行ビルドする。両方終了するまで後続検査へ進まない。
lkc_build_started=$SECONDS
npm run build:staging -w @lkc/staff &
lkc_staff_pid=$!
npm run build:staging -w @lkc/admin &
lkc_admin_pid=$!
lkc_build_failed=0
wait "$lkc_staff_pid" || lkc_build_failed=1
wait "$lkc_admin_pid" || lkc_build_failed=1
if [[ "$lkc_build_failed" != 0 ]]; then
  echo 'HOSTING_BUILD_RESULT=FAILED'
  exit 1
fi
echo 'HOSTING_BUILD_RESULT=SUCCESS'
echo "HOSTING_BUILD_DURATION_SECONDS=$((SECONDS-lkc_build_started))"

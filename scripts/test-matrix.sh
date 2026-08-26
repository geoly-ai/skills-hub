#!/usr/bin/env bash
# Gate 2：在最低支持版本与 current LTS 上跑全部测试
set -u
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; . "$NVM_DIR/nvm.sh"
FAIL=0
for V in 22.13.0 24.19.0; do
  echo "════════ Node v$V ════════"
  nvm use "$V" >/dev/null 2>&1 || { echo "❌ 未安装 v$V"; FAIL=1; continue; }
  node -v
  node --test test/*.test.mjs 2>&1 | grep -vE "ExperimentalWarning|trace-warnings" | tail -9
  [ "${PIPESTATUS[0]}" != "0" ] && FAIL=1
done
exit $FAIL

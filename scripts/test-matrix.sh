#!/usr/bin/env bash
# Gate 2：在最低支持版本与 current LTS 上跑全部测试
#
# 🔴 版本清单的**唯一源**是 scripts/node-versions.json —— 本脚本与
#    .github/workflows/ci.yml 都从那里读。两处各写一份清单必然漂移，
#    所以 scripts/check-node-matrix.mjs 会扫 workflow，发现硬编码就报错。
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSIONS_JSON="$HERE/node-versions.json"
[ -f "$VERSIONS_JSON" ] || { echo "❌ 找不到 $VERSIONS_JSON"; exit 1; }

# 故意不依赖 node/jq：这个脚本要在 `nvm use` 之前就能读出清单。
# node-versions.json 是一个扁平字符串数组，形状由 check-node-matrix.mjs 守着。
VERSIONS="$(tr -d '[]" \t\r\n' < "$VERSIONS_JSON" | tr ',' ' ')"
[ -n "$VERSIONS" ] || { echo "❌ node-versions.json 解析出空清单"; exit 1; }

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; . "$NVM_DIR/nvm.sh"
FAIL=0
for V in $VERSIONS; do
  echo "════════ Node v$V ════════"
  nvm use "$V" >/dev/null 2>&1 || { echo "❌ 未安装 v$V"; FAIL=1; continue; }
  node -v
  node --test test/*.test.mjs 2>&1 | grep -vE "ExperimentalWarning|trace-warnings" | tail -9
  [ "${PIPESTATUS[0]}" != "0" ] && FAIL=1
done
exit $FAIL

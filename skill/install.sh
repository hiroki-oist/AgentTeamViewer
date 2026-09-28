#!/bin/sh
# atv コマンドと Claude Code の skill (atv-orchestrate) をユーザー環境に入れる。
# どちらもシンボリックリンクなので、この repo を更新すればそのまま反映される。
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
BIN=${ATV_BIN_DIR:-$HOME/.local/bin}
SKILLS=${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}

chmod +x "$HERE/orchestrator/cli.js"
mkdir -p "$BIN" "$SKILLS"
ln -sf "$HERE/orchestrator/cli.js" "$BIN/atv"
ln -sfn "$HERE/skill/atv-orchestrate" "$SKILLS/atv-orchestrate"

echo "atv   → $BIN/atv"
echo "skill → $SKILLS/atv-orchestrate"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "注意: $BIN が PATH にありません" ;; esac

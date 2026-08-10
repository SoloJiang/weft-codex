#!/bin/sh
# Install weft-codex's Codex skills into the user's Codex home.
#
# Skills live in the user's Codex config, not in weft-codex's own prefix, so
# this is deliberately a separate, explicit step rather than something the
# launcher does behind your back on startup.
#
#   scripts/install-skills.sh            # install, refusing to clobber edits
#   scripts/install-skills.sh --force    # overwrite local modifications
#   CODEX_HOME=/tmp/x scripts/install-skills.sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SOURCE_DIR="$PROJECT_ROOT/skills"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *)
      echo "install-skills: unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [ ! -d "$SOURCE_DIR" ]; then
  echo "install-skills: no skills/ directory at $SOURCE_DIR" >&2
  exit 1
fi

CODEX_HOME=${CODEX_HOME:-"$HOME/.codex"}
TARGET_DIR="$CODEX_HOME/skills"
mkdir -p "$TARGET_DIR"

installed=0
skipped=0
for skill_path in "$SOURCE_DIR"/*/; do
  [ -d "$skill_path" ] || continue
  skill=$(basename "$skill_path")
  source_file="$skill_path/SKILL.md"
  if [ ! -f "$source_file" ]; then
    echo "install-skills: $skill has no SKILL.md, skipping" >&2
    continue
  fi
  target_file="$TARGET_DIR/$skill/SKILL.md"

  # Only refuse when the installed copy differs from ours *and* the caller did
  # not ask for it: an identical file is a no-op, not a conflict.
  if [ -f "$target_file" ] && [ "$FORCE" -eq 0 ]; then
    if ! cmp -s "$source_file" "$target_file"; then
      echo "install-skills: $skill differs from the installed copy; re-run with --force to overwrite" >&2
      skipped=$((skipped + 1))
      continue
    fi
  fi

  mkdir -p "$TARGET_DIR/$skill"
  cp "$source_file" "$target_file"
  installed=$((installed + 1))
  echo "install-skills: installed $skill -> $target_file"
done

echo "install-skills: $installed installed, $skipped skipped"
[ "$skipped" -eq 0 ] || exit 3

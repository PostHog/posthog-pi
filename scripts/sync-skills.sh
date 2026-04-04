#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AI_PLUGIN_DIR="${AI_PLUGIN_DIR:-$ROOT_DIR/../ai-plugin}"
TARGET_DIR="$ROOT_DIR/skills"

if [ ! -d "$AI_PLUGIN_DIR/skills" ]; then
  echo "Error: could not find ai-plugin skills at: $AI_PLUGIN_DIR/skills" >&2
  echo "Set AI_PLUGIN_DIR=/path/to/ai-plugin if needed." >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
rsync -a --delete "$AI_PLUGIN_DIR/skills/" "$TARGET_DIR/"

echo "Synced PostHog skills from: $AI_PLUGIN_DIR/skills"
echo "Into: $TARGET_DIR"

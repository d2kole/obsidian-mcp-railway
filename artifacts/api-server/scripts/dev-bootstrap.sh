#!/usr/bin/env bash
set -euo pipefail

DEV_DIR="${DEV_VAULT_DIR:-/tmp/obsidian-mcp-dev}"
SEED_DIR="$DEV_DIR/seed"
BARE_DIR="$DEV_DIR/vault.git"
CACHE_DIR="$DEV_DIR/cache"

if [ ! -d "$BARE_DIR" ]; then
  rm -rf "$DEV_DIR"
  mkdir -p "$SEED_DIR" "$CACHE_DIR"
  (
    cd "$SEED_DIR"
    git init -q -b main
    git config user.email "dev@local"
    git config user.name "Dev"
    mkdir -p 00-Inbox Journal
    printf '# Welcome\n\nLocal dev vault.\n' > README.md
    printf '# Inbox\n' > 00-Inbox/.gitkeep
    printf '# Journal\n' > Journal/.gitkeep
    git add -A
    git commit -q -m "seed"
  )
  git clone -q --bare "$SEED_DIR" "$BARE_DIR"
fi

export VAULT_REPO_URL="file://$BARE_DIR"
export VAULT_BRANCH="main"
export VAULT_CACHE_DIR="$CACHE_DIR"
export GITHUB_PAT="dev-not-used-for-file-remote"
export OBSIDIAN_WRITE_PATHS="00-Inbox,Journal"
export OAUTH_CLIENT_SECRET="dev-client-secret"
export SESSION_ENCRYPTION_KEY="dev-session-key-padding-padding-x"
export PERSONAL_AUTH_TOKEN="dev-personal-token"
export OAUTH_STORE_PATH="$CACHE_DIR/.oauth-store.json"
export BASE_URL="${BASE_URL:-http://localhost:${PORT:-3000}}"

exec "$@"

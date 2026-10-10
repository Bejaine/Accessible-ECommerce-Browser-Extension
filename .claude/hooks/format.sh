#!/usr/bin/env bash
# Runs after every file edit Claude makes, so all teammates' agents produce identical style.
# Needs: jq, prettier (root devDependency), ruff. Never blocks the edit.
f=$(jq -r '.tool_input.file_path // empty')
[ -z "$f" ] && exit 0
case "$f" in
  *.ts|*.tsx|*.js|*.jsx|*.json|*.css|*.html)
    npx --no-install prettier --write "$f" >/dev/null 2>&1 ;;
  *.py)
    ruff format "$f" >/dev/null 2>&1
    ruff check --fix "$f" >/dev/null 2>&1 ;;
esac
exit 0

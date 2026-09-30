#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
version="$(cat core/.nvmrc)"
if [[ "${2:-}" != "--help" && "$(node --version 2>/dev/null || true)" != "v$version" ]]; then
  nvm_script="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  if [[ ! -f "$nvm_script" ]]; then
    echo "Kipster needs Node $version. Install/select that version, then rerun this command." >&2
    exit 1
  fi
  source "$nvm_script"
  if [[ "$(nvm version "$version")" == "N/A" ]]; then nvm install "$version"; fi
  nvm use --silent "$version"
fi
if [[ "$1" == "test" ]]; then
  exec node --test scripts/tests/*.test.mjs
fi
if [[ "$1" == "test-full" ]]; then
  exec node --test scripts/tests/*.test.mjs scripts/tests/integration/*.test.mjs
fi
exec node scripts/local.mjs "$@"

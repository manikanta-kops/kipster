#!/usr/bin/env bash
# Run personally: stdout contains only the public key; keep the key and password in 1Password.
set +x
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

if [[ $# -ne 1 || "$1" != /* || ! -t 0 ]]; then
  echo 'Usage (in your own terminal): bash scripts/setup-updater-key.sh /absolute/private/key/path' >&2
  exit 2
fi
key_path="$1"
repository_root="$(pwd -P)"
case "$key_path" in
  "$repository_root"/*) echo 'Store the private key outside the repository.' >&2; exit 1 ;;
esac
if [[ -e "$key_path" || -e "$key_path.pub" ]]; then
  echo 'Refusing to overwrite an existing updater key pair.' >&2
  exit 1
fi
gh auth status >/dev/null 2>&1
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs'
const config = JSON.parse(readFileSync('interface/kipster-ui/src-tauri/tauri.conf.json', 'utf8'))
if (config.plugins?.updater?.pubkey?.trim()) {
  throw new Error('An updater public key is already configured. Do not rotate released clients to a new key.')
}
NODE

trap 'unset updater_password confirm_password TAURI_SIGNING_PRIVATE_KEY_PASSWORD' EXIT
IFS= read -r -s -p 'New updater key password (save it in 1Password): ' updater_password
printf '\n' >&2
IFS= read -r -s -p 'Confirm password: ' confirm_password
printf '\n' >&2
if [[ -z "$updater_password" || "$updater_password" != "$confirm_password" ]]; then
  echo 'Passwords must be nonempty and match.' >&2
  exit 1
fi
unset confirm_password
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$updater_password"
mkdir -p "$(dirname "$key_path")"
# Pass the password in memory to the CLI API, never in process arguments or logs.
if ! node --input-type=module - "$key_path" <<'NODE' >/dev/null 2>&1
import { run } from '@tauri-apps/cli'
await run(['signer', 'generate', '--ci', '--write-keys', process.argv[2],
  '--password', process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD])
NODE
then
  echo 'Key generation failed. Check the private key path before retrying.' >&2
  exit 1
fi
chmod 600 "$key_path"
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo manikanta-kops/kipster --env release < "$key_path" >/dev/null
printf '%s' "$updater_password" | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo manikanta-kops/kipster --env release >/dev/null
unset updater_password TAURI_SIGNING_PRIVATE_KEY_PASSWORD

node --input-type=module - "$key_path.pub" <<'NODE'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
const path = 'interface/kipster-ui/src-tauri/tauri.conf.json'
const config = JSON.parse(readFileSync(path, 'utf8'))
const pubkey = readFileSync(process.argv[2], 'utf8').trim()
config.plugins.updater.pubkey = pubkey
writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
execFileSync('npm', ['exec', '--', 'prettier', '--write', path], { stdio: 'ignore' })
console.log(pubkey)
NODE
echo 'Back up the private key file and password in 1Password. Commit the updated tauri.conf.json before publishing a signed app release.' >&2

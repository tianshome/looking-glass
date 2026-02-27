#!/usr/bin/env bash
set -euo pipefail

# Signs ./directives.yml using ssh-keygen -Y sign.
#
# Usage:
#   ./scripts/sign_directives.sh ./keys/lg_directives_ed25519
#
# Produces:
#   ./directives.yml.sig
#
# Convention used by the agent:
# - signer identity (principal): lg-directives
# - namespace: lg-directives

KEY_PATH="${1:-}"
if [[ -z "$KEY_PATH" ]]; then
  echo "usage: $0 <ed25519_private_key_path>" >&2
  exit 1
fi

ssh-keygen -Y sign -f "$KEY_PATH" -n lg-directives directives.yml

echo "Wrote directives.yml.sig"

cat <<'NOTE'

Next steps:
1) Deploy the worker (npx wrangler deploy from worker/).
   - DIRECTIVES_YAML and DIRECTIVES_SIG are auto-embedded from directives.yml and directives.yml.sig.
2) Ensure agents are configured with the corresponding public key via -pubkey.

NOTE

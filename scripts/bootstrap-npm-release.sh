#!/usr/bin/env bash

set -euo pipefail

repository_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_directory"

registry="https://registry.npmjs.org"
package_name="$(node --input-type=module --eval 'import manifest from "./package.json" with { type: "json" }; process.stdout.write(manifest.name)')"
package_version="$(node --input-type=module --eval 'import manifest from "./package.json" with { type: "json" }; process.stdout.write(manifest.version)')"
repository="2heal1/t-vis"
workflow="release.yml"
package_directory="$(mktemp -d "${TMPDIR:-/tmp}/t-vis-npm-release.XXXXXX")"

cleanup() {
  rm -rf "$package_directory"
}
trap cleanup EXIT

if [[ ! -t 0 ]]; then
  echo "Run this command interactively so the OTP can be entered securely." >&2
  exit 1
fi

npm whoami --registry="$registry" >/dev/null

if npm view "${package_name}@${package_version}" version --registry="$registry" >/dev/null 2>&1; then
  echo "${package_name}@${package_version} is already published; refusing to overwrite it." >&2
  exit 1
fi

npm run check

pack_result="$(npm pack --json --pack-destination "$package_directory" --registry="$registry")"
archive_name="$(node --input-type=module --eval 'const input = await new Response(process.stdin).text(); const result = JSON.parse(input); process.stdout.write(result[0].filename)' <<<"$pack_result")"
archive_path="${package_directory}/${archive_name}"

if [[ ! -f "$archive_path" ]]; then
  echo "Expected npm archive was not created: ${archive_path}" >&2
  exit 1
fi

read -r -s -p "npm OTP for ${package_name}@${package_version}: " otp
printf "\n"
if [[ ! "$otp" =~ ^[0-9]{6,8}$ ]]; then
  echo "OTP must contain 6 to 8 digits." >&2
  exit 1
fi

npm publish "$archive_path" --access public --registry="$registry" --otp="$otp"
unset otp

npm view "${package_name}@${package_version}" version --registry="$registry"
npm trust github "$package_name" \
  --repo="$repository" \
  --file="$workflow" \
  --allow-publish \
  --yes

echo "Published ${package_name}@${package_version} and configured GitHub Actions trusted publishing."

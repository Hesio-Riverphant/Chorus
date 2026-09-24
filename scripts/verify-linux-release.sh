#!/usr/bin/env bash
set -euo pipefail
# Installation is limited to the disposable GitHub runner used for this job.
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == Linux ]]
release_dir=$(node -p "require('./dist/CURRENT-RELEASE.json').directory")
[[ "$release_dir" =~ ^Chorus-[0-9]+\.[0-9]+\.[0-9]+-linux-release-[A-Za-z0-9]+$ ]]
release_dir="$PWD/dist/$release_dir"
version=$(node -p "require('./package.json').version")
zip_file="$release_dir/artifacts/Chorus-$version-linux-x64.zip"
deb_file="$release_dir/artifacts/Chorus-$version-linux-amd64.deb"
zip_dir="$release_dir/zip-verification"
mkdir "$zip_dir"
unzip -q "$zip_file" -d "$zip_dir"
node scripts/check-release.js --bundle "$zip_dir"
test -x "$zip_dir/chorus"
# Test the documented ZIP setup without the build-only AppArmor grant.
sudo apparmor_parser -R "$RUNNER_TEMP/chorus-ci-apparmor"
sudo chown root:root "$zip_dir/chrome-sandbox"
sudo chmod 4755 "$zip_dir/chrome-sandbox"
node scripts/package-desktop.js --smoke-existing "$zip_dir"
trap 'sudo dpkg -r chorus' EXIT
sudo apt-get install -y "$deb_file"
node scripts/check-release.js --bundle /opt/Chorus
node scripts/package-desktop.js --smoke-existing /opt/Chorus
sudo dpkg -r chorus
trap - EXIT
test ! -e /opt/Chorus/chorus
printf '%s\n' 'Verified Ubuntu ZIP, Debian installation, isolated startup and package removal.'

#!/bin/sh
# Explicit operator installation only; capture requests never download dependencies.
set -eu
cd "$(dirname "$0")"
case "${1:-}" in
  ''|--with-deps) ;;
  *) echo 'Usage: sh preview-browser/build.sh [--with-deps]' >&2; exit 2 ;;
esac
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.browsers"
# prepare-preview already runs npm ci; standalone use installs the same locked dependency.
if ! node --input-type=module -e "import fs from 'node:fs'; const expected=JSON.parse(fs.readFileSync('package.json')).dependencies['playwright-core']; const actual=JSON.parse(fs.readFileSync('node_modules/playwright-core/package.json')).version; if(actual!==expected) process.exit(1)" 2>/dev/null; then
  npm ci --ignore-scripts --include=dev --no-audit --no-fund
fi
# Linux deployments use the official Node bookworm base (Debian/Ubuntu).
run_privileged() {
  if [ "$(id -u)" = 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -n "$@"
  else
    echo 'System dependency installation requires root or non-interactive sudo.' >&2
    exit 1
  fi
}
# Playwright selects its official version-matched CDN; optional proxies come from the operator.
unset PLAYWRIGHT_DOWNLOAD_HOST PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST
HTTPS_PROXY=${https_proxy:-${HTTPS_PROXY:-${http_proxy:-${HTTP_PROXY:-}}}}
export HTTPS_PROXY
if [ "$(uname -s)" = Linux ]; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo 'Use a Debian/Ubuntu deployment image such as node:24-bookworm.' >&2
    exit 1
  fi
  run_privileged env PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" \
    HTTPS_PROXY="$HTTPS_PROXY" node node_modules/playwright-core/cli.js install --with-deps chromium
  run_privileged apt-get install -y --no-install-recommends procps fontconfig fonts-noto-cjk
  run_privileged fc-cache -f
else
  node node_modules/playwright-core/cli.js install chromium
fi
echo '[preview] Checking Chromium libraries and screenshot startup'
# Smoke test with the same fixed browser path, clean environment and sandbox as capture.
env -i PATH="$PATH" HOME="${TMPDIR:-/tmp}" TMPDIR="${TMPDIR:-/tmp}" LANG=en_US.UTF-8   PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" node --input-type=module <<'NODE'
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyChineseFonts } from './verify-fonts.mjs';

if (process.platform === 'linux') {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  try { execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 1000 }); }
  catch { console.error('Missing /bin/ps: install procps (Debian/Ubuntu).'); process.exit(1); }
  const binaries = [chromium.executablePath()];
  for (const entry of readdirSync(root, { recursive: true })) {
    if (/(?:^|\/)(?:headless_shell|chrome-headless-shell)$/.test(entry))
      binaries.push(resolve(root, entry));
  }
  for (const binary of binaries) {
    let report;
    try {
      report = execFileSync('ldd', [binary], { encoding: 'utf8', timeout: 10000 });
    } catch (error) {
      console.error(`Chromium dependency inspection failed: ${binary}. Install ldd and browser libraries.`, error.message);
      process.exit(1);
    }
    if (/not found/.test(report)) {
      console.error(`Missing Chromium libraries for ${binary}:\n${report}`);
      process.exit(1);
    }
  }
}
const deadline = setTimeout(() => {
  console.error('Chromium launch smoke test timed out');
  process.exit(1);
}, 30000);
let browser;
try {
  browser = await chromium.launch({ headless: true, chromiumSandbox: false, timeout: 20000 });
  const page = await browser.newPage();
  await verifyChineseFonts(page);
  console.log(`Local Chromium ${browser.version()} launch and screenshot OK`);
} catch (error) {
  console.error('Chromium smoke test failed. Check system libraries, browser executable permissions and deployment architecture; see README.md.', error.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  clearTimeout(deadline);
}
NODE

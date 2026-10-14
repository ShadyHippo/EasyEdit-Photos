#!/usr/bin/env bash
# EasyEdit end-to-end suite.
#
#   tests/run.sh                    run the full suite
#   tests/run.sh path/to/script.ts  run a different CDP script against the same rig
#
#   EASYEDIT_URL=http://host:3100/ tests/run.sh     point at a different instance
#   CDP_PORT=9333 STUB_PORT=7998 tests/run.sh       avoid port clashes
#
# Requires: chromium, deno, python3, curl.
#
# Drives a real headless Chromium over the Chrome DevTools Protocol with real input
# events (mouse, touch, keyboard) and inspects real canvas pixels. No npm, no
# Playwright. It starts/stops its own chromium and a stub rembg server, so nothing
# needs to be running first - except the editor itself at $EASYEDIT_URL.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${CDP_PORT:-9222}"
STUB_PORT="${STUB_PORT:-7999}"
WORK="${EASYEDIT_WORK:-${TMPDIR:-/tmp}/easyedit-test}"
FIX="$WORK/fixtures"

export EASYEDIT_FIXTURES="$FIX"
export EASYEDIT_WORK="$WORK"
export EASYEDIT_URL="${EASYEDIT_URL:-http://localhost:3100/}"
export CDP_PORT="$PORT"
export STUB_PORT="$STUB_PORT"

mkdir -p "$WORK"
python3 "$HERE/make_fixtures.py" "$FIX" >/dev/null || { echo "fixture generation failed"; exit 5; }

pkill -f "remote-debugging-port=$PORT" 2>/dev/null
pkill -f stub_rembg.py 2>/dev/null
rm -rf "$WORK/cdpprof" "$WORK/dl"
mkdir -p "$WORK/dl"

python3 "$HERE/stub_rembg.py" "$STUB_PORT" >"$WORK/stub.log" 2>&1 &
SPID=$!
sleep 1
if ! curl -sf "http://127.0.0.1:$STUB_PORT/stats" >/dev/null; then
  echo "STUB FAILED TO START"; cat "$WORK/stub.log"; kill $SPID 2>/dev/null; exit 4
fi

chromium --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --remote-debugging-port="$PORT" --remote-allow-origins='*' \
  --user-data-dir="$WORK/cdpprof" --window-size=1400,900 about:blank \
  >"$WORK/chrome.log" 2>&1 &
CPID=$!

UP=0
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then UP=1; break; fi
  sleep 0.25
done
if [ "$UP" != 1 ]; then
  echo "CHROMIUM FAILED TO START"; tail -20 "$WORK/chrome.log"
  kill $CPID $SPID 2>/dev/null; exit 3
fi

if [ -n "${1:-}" ]; then
  deno run -A "$1"
  RC=$?
else
  deno run -A "$HERE/e2e.ts"
  RC=$?
  if [ "$RC" -eq 0 ]; then
    echo
    deno run -A "$HERE/mobile.ts"
    RC=$?
  fi
fi

kill $CPID $SPID 2>/dev/null
pkill -f "remote-debugging-port=$PORT" 2>/dev/null
pkill -f stub_rembg.py 2>/dev/null
exit $RC

#!/bin/sh
# Download the MediaPipe Tasks Vision runtime + models used by the Fly Ask camera feature into
# web/vendor/mediapipe/ (git-ignored). Idempotent: files that already match their SHA-256 are skipped.
# Downloads go to <file>.part and are moved into place only after the SHA-256 matches.
# Usage: sh scripts/fetch_camera_assets.sh [--force]
set -eu

VER="0.10.21"
CDN="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}"
GCS="https://storage.googleapis.com/mediapipe-models"
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DEST="$ROOT/web/vendor/mediapipe"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

if command -v sha256sum >/dev/null 2>&1; then sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else echo "need sha256sum or shasum" >&2; exit 1; fi
if command -v curl >/dev/null 2>&1; then dl() { curl -fL --retry 3 --connect-timeout 20 -sS -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then dl() { wget -q -O "$2" "$1"; }
else echo "need curl or wget" >&2; exit 1; fi

# fetch <url> <relative dest> <sha256>
fetch() {
  url=$1; rel=$2; want=$3; out="$DEST/$rel"
  mkdir -p "$(dirname "$out")"
  if [ "$FORCE" = 0 ] && [ -f "$out" ] && [ "$(sha "$out")" = "$want" ]; then
    echo "ok       $rel"; return 0
  fi
  echo "download $rel"
  rm -f "$out.part"
  dl "$url" "$out.part" || { rm -f "$out.part"; echo "FAILED: $url" >&2; exit 1; }
  got=$(sha "$out.part")
  if [ "$got" != "$want" ]; then
    rm -f "$out.part"
    echo "SHA-256 mismatch for $rel: expected $want got $got" >&2
    exit 1
  fi
  mv "$out.part" "$out"
}

fetch "$CDN/package.json"                         package.json                        18e96c370b666f1f6b096c96255f19a4750522d207cff5dc721aeb4c4e4da701
fetch "$CDN/vision_bundle.mjs"                    vision_bundle.mjs                   40f4123dfcd75cfa58add046919cc6f52fde66f009ff582997c09ba54c6ba27c
fetch "$CDN/wasm/vision_wasm_internal.js"         wasm/vision_wasm_internal.js        4a97e2520ba506c680ecd6ba6acfb146888afa0e2746d57f205352bc6ebb82eb
fetch "$CDN/wasm/vision_wasm_internal.wasm"       wasm/vision_wasm_internal.wasm      f00ec4731faa23b3e714d00e88d4d10e2df5c0a427d3a2b4ae6e3526fdd14ef7
fetch "$CDN/wasm/vision_wasm_nosimd_internal.js"  wasm/vision_wasm_nosimd_internal.js 927def7b465c51b86e4b3060f93646aca4e27121f4b8fc0483786e407ea9cf1f
fetch "$CDN/wasm/vision_wasm_nosimd_internal.wasm" wasm/vision_wasm_nosimd_internal.wasm 3821ea9b1f7fb8c549ef2a064ef5c85750bf375c545a49fd6eea0df44a95f1f4
fetch "$GCS/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task" pose_landmarker_lite.task 59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a
fetch "$GCS/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task"  gesture_recognizer.task  97952348cf6a6a4915c2ea1496b4b37ebabc50cbbf80571435643c455f2b0482

echo "done: $DEST"

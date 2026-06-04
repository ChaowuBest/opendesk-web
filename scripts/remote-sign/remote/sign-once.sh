#!/usr/bin/env bash
# Sign + notarize + staple a single unsigned .app.zip on a Linux host with rcodesign.
#
# Inputs:
#   $1  path to unsigned .app.zip
#   $2  path where the signed+stapled .app.zip will be written
#
# Reads credentials from ${WORK_ROOT}/secrets/env:
#   P12_PATH              # default ${WORK_ROOT}/secrets/cert.p12
#   P12_PASSWORD          # required
#   API_KEY_PATH          # default ${WORK_ROOT}/secrets/api_key.p8
#   APP_STORE_ISSUER_ID   # required (UUID)
#   APP_STORE_KEY_ID      # required (10 chars)
#   BUNDLE_ID             # default com.intellios.opendesk
#   ENTITLEMENTS_DIR      # default ${WORK_ROOT}/entitlements
#   SKIP_NOTARIZE         # optional: "1" to sign only

set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "usage: $0 <input.app.zip> <output.app.zip>" >&2
    exit 2
fi

INPUT="$1"
OUTPUT="$2"

WORK_ROOT="${WORK_ROOT:-${HOME}/sign-server}"
# shellcheck disable=SC1091
source "${WORK_ROOT}/secrets/env"

P12_PATH="${P12_PATH:-${WORK_ROOT}/secrets/cert.p12}"
API_KEY_PATH="${API_KEY_PATH:-${WORK_ROOT}/secrets/api_key.p8}"
BUNDLE_ID="${BUNDLE_ID:-com.intellios.opendesk}"
ENT_DIR="${ENTITLEMENTS_DIR:-${WORK_ROOT}/entitlements}"

required_vars=(P12_PASSWORD)
required_files=("${P12_PATH}"
                "${ENT_DIR}/app.plist" "${ENT_DIR}/renderer.plist"
                "${ENT_DIR}/gpu.plist" "${ENT_DIR}/plugin.plist")
if [[ "${SKIP_NOTARIZE:-0}" != "1" ]]; then
    required_vars+=(APP_STORE_ISSUER_ID APP_STORE_KEY_ID)
    required_files+=("${API_KEY_PATH}")
fi

for v in "${required_vars[@]}"; do
    if [[ -z "${!v:-}" ]]; then
        echo "missing env var: $v" >&2
        exit 2
    fi
done

for f in "${required_files[@]}"; do
    [[ -f "${f}" ]] || { echo "missing file: $f" >&2; exit 2; }
done

JOB_ID="$(date +%Y%m%d-%H%M%S)-$$"
JOB_DIR="${WORK_ROOT}/jobs/${JOB_ID}"
mkdir -p "${JOB_DIR}"
trap 'rm -rf "${JOB_DIR}"' EXIT

echo "[1/6] unpacking ${INPUT}"
unzip -q "${INPUT}" -d "${JOB_DIR}/unsigned"
APP_PATH="$(find "${JOB_DIR}/unsigned" -maxdepth 2 -name '*.app' -type d ! -name '._*' | head -n1)"
[[ -n "${APP_PATH}" ]] || { echo "no .app bundle found in input zip" >&2; exit 1; }
APP_NAME="$(basename "${APP_PATH}")"
echo "      bundle: ${APP_NAME}"

# Strip AppleDouble companion files left over from macOS xattrs — they confuse
# rcodesign's nested bundle scanner and would fail notarization anyway.
find "${APP_PATH}" -name '._*' -delete
find "${APP_PATH}" -name '.DS_Store' -delete

# Helper bundle paths inside an Electron .app (relative to the outer bundle root).
HELPER_PATHS=(
    "Contents/Frameworks/${APP_NAME%.app} Helper.app"
    "Contents/Frameworks/${APP_NAME%.app} Helper (Renderer).app"
    "Contents/Frameworks/${APP_NAME%.app} Helper (GPU).app"
    "Contents/Frameworks/${APP_NAME%.app} Helper (Plugin).app"
)

# Standalone Mach-O executables nested inside frameworks — Apple notary
# requires hardened runtime on these too, and rcodesign does not propagate
# the flag automatically into framework Helpers/Resources.
NESTED_BINARIES=(
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler"
    "Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt"
)

echo "[2/6] signing"
rcodesign sign \
    --p12-file "${P12_PATH}" \
    --p12-password "${P12_PASSWORD}" \
    --code-signature-flags runtime \
    --entitlements-xml-path "${ENT_DIR}/app.plist" \
    --code-signature-flags "${HELPER_PATHS[0]}:runtime" \
    --entitlements-xml-path "${HELPER_PATHS[0]}:${ENT_DIR}/renderer.plist" \
    --code-signature-flags "${HELPER_PATHS[1]}:runtime" \
    --entitlements-xml-path "${HELPER_PATHS[1]}:${ENT_DIR}/renderer.plist" \
    --code-signature-flags "${HELPER_PATHS[2]}:runtime" \
    --entitlements-xml-path "${HELPER_PATHS[2]}:${ENT_DIR}/gpu.plist" \
    --code-signature-flags "${HELPER_PATHS[3]}:runtime" \
    --code-signature-flags "${NESTED_BINARIES[0]}:runtime" \
    --code-signature-flags "${NESTED_BINARIES[1]}:runtime" \
    --entitlements-xml-path "${HELPER_PATHS[3]}:${ENT_DIR}/plugin.plist" \
    "${APP_PATH}"

echo "[3/6] basic sanity check"
# rcodesign verify only handles single Mach-O, not bundles. Verify the inner
# binary as a smoke test; full bundle verification happens on the mac with codesign.
INNER_BIN="${APP_PATH}/Contents/MacOS/$(basename "${APP_PATH%.app}")"
[[ -x "${INNER_BIN}" ]] && rcodesign verify "${INNER_BIN}" || echo "(skipped: ${INNER_BIN})"

if [[ "${SKIP_NOTARIZE:-0}" == "1" ]]; then
    echo "[4/6] skip notarize (SKIP_NOTARIZE=1)"
else
    echo "[4/6] zipping for notary submission"
    SIGNED_ZIP="${JOB_DIR}/signed-for-notary.zip"
    ( cd "$(dirname "${APP_PATH}")" && zip -qry "${SIGNED_ZIP}" "$(basename "${APP_PATH}")" )

    echo "[5/6] notarize + staple (wait)"
    rcodesign notary-submit \
        --api-key-path "${API_KEY_PATH}" \
        --api-issuer "${APP_STORE_ISSUER_ID}" \
        --api-key "${APP_STORE_KEY_ID}" \
        --staple \
        "${SIGNED_ZIP}"

    # rcodesign --staple stapled the bundle inside JOB_DIR/unsigned; nothing to copy.
fi

echo "[6/6] packing result to ${OUTPUT}"
( cd "$(dirname "${APP_PATH}")" && zip -qry "${OUTPUT}" "$(basename "${APP_PATH}")" )

echo
echo "done: ${OUTPUT}"

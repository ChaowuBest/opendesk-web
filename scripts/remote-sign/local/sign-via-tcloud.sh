#!/usr/bin/env bash
# Hybrid local driver:
#   1. ditto-zip an unsigned .app
#   2. scp it to the tcloud signing host
#   3. ssh-run sign-once.sh in SKIP_NOTARIZE=1 mode (rcodesign sign only)
#   4. scp the signed .app.zip back
#   5. notarize + staple LOCALLY via xcrun notarytool (uses opendesk-notary keychain profile)
#   6. verify with codesign / spctl / stapler
#
# Usage:
#   SSH_TARGET=tcloud bash scripts/remote-sign/local/sign-via-tcloud.sh path/to/opendesk.app [out/dir]
#
# Env knobs:
#   SSH_TARGET           required, e.g.  tcloud  or  user@1.2.3.4
#   SSH_KEY              optional path to private key      (default: ssh-agent default)
#   REMOTE_ROOT          default /root/sign-server (or ~/sign-server if non-root)
#   NOTARY_PROFILE       default opendesk-notary
#   SKIP_NOTARIZE        "1" to skip the local notarize+staple step (verify signature only)

set -euo pipefail

APP_IN="${1:?usage: $0 <path/to/opendesk.app> [out-dir]}"
OUT_DIR="${2:-out/remote-signed}"

[[ -d "${APP_IN}" && "${APP_IN}" == *.app ]] || {
    echo "expected a .app bundle, got: ${APP_IN}" >&2; exit 2; }

SSH_TARGET="${SSH_TARGET:?set SSH_TARGET=user@host}"
REMOTE_ROOT="${REMOTE_ROOT:-/root/sign-server}"
NOTARY_PROFILE="${NOTARY_PROFILE:-opendesk-notary}"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=60)
[[ -n "${SSH_KEY:-}" ]] && SSH_OPTS+=(-i "${SSH_KEY}")

mkdir -p "${OUT_DIR}"
JOB_ID="$(date +%Y%m%d-%H%M%S)-$$"
APP_NAME="$(basename "${APP_IN}")"
LOCAL_WORK="$(mktemp -d -t opendesk-sign.XXXXXX)"
trap 'rm -rf "${LOCAL_WORK}"' EXIT

echo "[1/6] zipping unsigned bundle (ditto)"
ditto -c -k --keepParent "${APP_IN}" "${LOCAL_WORK}/${JOB_ID}-unsigned.zip"

REMOTE_INPUT="${REMOTE_ROOT}/jobs/${JOB_ID}-unsigned.zip"
REMOTE_OUTPUT="${REMOTE_ROOT}/jobs/${JOB_ID}-signed.zip"

echo "[2/6] upload to ${SSH_TARGET}:${REMOTE_INPUT}"
ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "mkdir -p ${REMOTE_ROOT}/jobs"
scp "${SSH_OPTS[@]}" "${LOCAL_WORK}/${JOB_ID}-unsigned.zip" "${SSH_TARGET}:${REMOTE_INPUT}"

echo "[3/7] running remote sign-once.sh (SKIP_NOTARIZE=1, signing only)"
ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" \
    "export PATH=\$HOME/.local/bin:\$PATH SKIP_NOTARIZE=1; \
     bash ${REMOTE_ROOT}/sign-once.sh '${REMOTE_INPUT}' '${REMOTE_OUTPUT}'"

echo "[4/7] downloading signed artifact"
scp "${SSH_OPTS[@]}" "${SSH_TARGET}:${REMOTE_OUTPUT}" "${LOCAL_WORK}/${JOB_ID}-signed.zip"

echo "[5/7] unpacking to ${OUT_DIR}/${APP_NAME}"
rm -rf "${OUT_DIR}/${APP_NAME}"
ditto -x -k "${LOCAL_WORK}/${JOB_ID}-signed.zip" "${OUT_DIR}"

echo "[6/7] signature verification"
codesign --verify --deep --strict --verbose=2 "${OUT_DIR}/${APP_NAME}" 2>&1 | tail -5
echo "---"
codesign -dvv "${OUT_DIR}/${APP_NAME}" 2>&1 | grep -E "Authority|TeamIdentifier|Runtime|Timestamp|Identifier"

if [[ "${SKIP_NOTARIZE:-0}" == "1" ]]; then
    echo
    echo "[7/7] skip notarize+staple (SKIP_NOTARIZE=1)"
    echo "(spctl will report 'rejected: source=Unnotarized Developer ID' — expected for signed-only)"
    spctl --assess --type execute --verbose=4 "${OUT_DIR}/${APP_NAME}" 2>&1 || true
else
    echo
    echo "[7/7] notarize + staple locally (keychain profile: ${NOTARY_PROFILE})"
    SIGNED_ZIP="${LOCAL_WORK}/${JOB_ID}-for-notary.zip"
    ditto -c -k --keepParent "${OUT_DIR}/${APP_NAME}" "${SIGNED_ZIP}"

    xcrun notarytool submit "${SIGNED_ZIP}" \
        --keychain-profile "${NOTARY_PROFILE}" \
        --wait

    xcrun stapler staple "${OUT_DIR}/${APP_NAME}"
    xcrun stapler validate "${OUT_DIR}/${APP_NAME}"

    echo "---"
    spctl --assess --type execute --verbose=4 "${OUT_DIR}/${APP_NAME}" 2>&1
fi

# Clean up remote job files (keep secrets/entitlements).
ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "rm -f ${REMOTE_INPUT} ${REMOTE_OUTPUT}"

echo
echo "result: ${OUT_DIR}/${APP_NAME}"

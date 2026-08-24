#!/usr/bin/env bash
# Hybrid local driver:
#   1. ditto-zip an unsigned .app
#   2. rsync (or scp) it to the tcloud signing host (with -z compression)
#   3. nohup-run sign-once.sh on remote, poll until done (survives SSH drops)
#   4. rsync (or scp) the signed .app.zip back
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
# Tighter keepalive for flaky trans-Pacific links — send a null packet every
# 10 s, allow up to 30 consecutive failures before giving up.
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=10 -o ServerAliveCountMax=30 -o TCPKeepAlive=yes)
[[ -n "${SSH_KEY:-}" ]] && SSH_OPTS+=(-i "${SSH_KEY}")

# --- rsync probe (used for both upload & download) ---
RSYNC_BIN=""
# Temporarily disable pipefail to avoid SIGPIPE (exit 141)
# from `head -1` closing the pipe early in the version check below.
set +o pipefail
for candidate in /opt/homebrew/bin/rsync /usr/local/bin/rsync /opt/local/bin/rsync; do
    if [[ -x "${candidate}" ]] && "${candidate}" --version 2>/dev/null | head -1 | grep -q "rsync  version 3"; then
        RSYNC_BIN="${candidate}"
        break
    fi
done
set -o pipefail
RSYNC_SSH="ssh -o ServerAliveInterval=10 -o ServerAliveCountMax=120 -o TCPKeepAlive=yes${SSH_KEY:+ -i ${SSH_KEY}}"

mkdir -p "${OUT_DIR}"
JOB_ID="$(date +%Y%m%d-%H%M%S)-$$"
APP_NAME="$(basename "${APP_IN}")"
LOCAL_WORK="$(mktemp -d -t opendesk-sign.XXXXXX)"
# Clean up local temp files on exit, but NOT on SIGINT during notarization
# (the notary zip must survive a Ctrl-C so we can resume).
trap 'rm -rf "${LOCAL_WORK}"' EXIT

echo "[1/7] zipping unsigned bundle (ditto)"
ditto -c -k --keepParent "${APP_IN}" "${LOCAL_WORK}/${JOB_ID}-unsigned.zip"

REMOTE_INPUT="${REMOTE_ROOT}/jobs/${JOB_ID}-unsigned.zip"
REMOTE_OUTPUT="${REMOTE_ROOT}/jobs/${JOB_ID}-signed.zip"
REMOTE_LOG="/tmp/sign-${JOB_ID}.log"

echo "[2/7] upload to ${SSH_TARGET}:${REMOTE_INPUT}"
ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "mkdir -p ${REMOTE_ROOT}/jobs"
if [[ -n "${RSYNC_BIN}" ]]; then
    "${RSYNC_BIN}" -z --partial --inplace --info=progress2 \
        -e "${RSYNC_SSH}" \
        "${LOCAL_WORK}/${JOB_ID}-unsigned.zip" "${SSH_TARGET}:${REMOTE_INPUT}"
else
    echo "      (GNU rsync not found — using scp. Install via 'brew install rsync' for compressed, resumable transfer.)"
    scp "${SSH_OPTS[@]}" "${LOCAL_WORK}/${JOB_ID}-unsigned.zip" "${SSH_TARGET}:${REMOTE_INPUT}"
fi

echo "[3/7] running remote sign-once.sh (SKIP_NOTARIZE=1, signing only)"
# Launch sign-once.sh in the background on the remote host via nohup so it
# survives SSH disconnections. Then poll the remote log until completion.
# The signing step takes ~30 s on the tcloud host.
ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" \
    "nohup bash -c 'export PATH=\$HOME/.local/bin:\$PATH SKIP_NOTARIZE=1; bash ${REMOTE_ROOT}/sign-once.sh ${REMOTE_INPUT} ${REMOTE_OUTPUT} > ${REMOTE_LOG} 2>&1; echo EXIT_CODE=\$? >> ${REMOTE_LOG}' </dev/null &>/dev/null &"

echo "      polling for completion (signing takes ~30 s)..."
POLL_INTERVAL=5
MAX_POLLS=72  # 6 minutes at 5 s intervals
for ((i=1; i<=MAX_POLLS; i++)); do
    STATUS=$(ssh "${SSH_OPTS[@]}" -o ConnectTimeout=10 "${SSH_TARGET}" \
        "if grep -q '^done:' ${REMOTE_LOG} 2>/dev/null; then echo DONE; \
         elif grep -q 'EXIT_CODE=[^0]' ${REMOTE_LOG} 2>/dev/null; then echo FAILED; \
         else echo WAITING; fi" 2>/dev/null || echo "SSH_FAIL")
    case "${STATUS}" in
        DONE)
            echo "      signing completed successfully"
            break
            ;;
        FAILED)
            echo "ERROR: remote signing failed. Remote log (${REMOTE_LOG}):"
            ssh "${SSH_OPTS[@]}" -o ConnectTimeout=10 "${SSH_TARGET}" "tail -40 ${REMOTE_LOG}" 2>/dev/null || true
            exit 1
            ;;
        SSH_FAIL)
            # SSH is temporarily unavailable — the remote process is still
            # running under nohup, so just wait and retry.
            ;;
    esac
    sleep "${POLL_INTERVAL}"
done

# Verify we actually finished (didn't just exhaust polls).
if ! ssh "${SSH_OPTS[@]}" -o ConnectTimeout=10 "${SSH_TARGET}" "grep -q '^done:' ${REMOTE_LOG}" 2>/dev/null; then
    echo "ERROR: signing did not complete within $((POLL_INTERVAL * MAX_POLLS)) s"
    echo "Remote log tail:"
    ssh "${SSH_OPTS[@]}" -o ConnectTimeout=10 "${SSH_TARGET}" "tail -20 ${REMOTE_LOG}" 2>/dev/null || true
    exit 1
fi

# Print a compact summary from the remote log.
ssh "${SSH_OPTS[@]}" -o ConnectTimeout=10 "${SSH_TARGET}" \
    "grep -E 'bundle:|signing|sanity|done:|packing' ${REMOTE_LOG}" 2>/dev/null || true

echo "[4/7] downloading signed artifact"
# Use GNU rsync 3.x for resumable transfer (--append-verify). The signed bundle
# is ~300 MB and the link between local mac and tcloud has been observed to drop
# mid-transfer; rsync resumes from the last good byte. macOS bundles openrsync
# (BSD reimplementation) which does NOT support --append-verify.
if [[ -n "${RSYNC_BIN}" ]]; then
    "${RSYNC_BIN}" -z --partial --append-verify --inplace --info=progress2 \
        -e "${RSYNC_SSH}" \
        "${SSH_TARGET}:${REMOTE_OUTPUT}" "${LOCAL_WORK}/${JOB_ID}-signed.zip"
else
    echo "      (GNU rsync not found — using scp. Install via 'brew install rsync' for resumable transfer on flaky links.)"
    scp "${SSH_OPTS[@]}" "${SSH_TARGET}:${REMOTE_OUTPUT}" "${LOCAL_WORK}/${JOB_ID}-signed.zip"
fi

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

    # notarytool submit --wait blocks 3–10 min. Tee the full transcript to a log
    # file and parse the submission ID only AFTER the pipeline completes: a
    # former `| head -1` here closed the pipe right after the id line, SIGPIPE-
    # killed notarytool mid-wait (exit 141), and `set -euo pipefail` aborted the
    # whole script before stapling / DMG. If the network still drops mid-wait,
    # the submission is queued on Apple's side and recoverable with:
    #   xcrun notarytool info <id> --keychain-profile opendesk-notary
    #   xcrun stapler staple out/signed/opendesk.app
    NOTARY_LOG="${LOCAL_WORK}/${JOB_ID}-notary.log"
    xcrun notarytool submit "${SIGNED_ZIP}" \
        --keychain-profile "${NOTARY_PROFILE}" \
        --wait 2>&1 | tee "${NOTARY_LOG}"
    SUBMISSION_ID=$(grep -m1 '^\s*id:' "${NOTARY_LOG}" | awk '{print $2}')
    if [[ -z "${SUBMISSION_ID}" ]]; then
        echo "WARNING: could not extract submission ID — check output above"
    fi

    xcrun stapler staple "${OUT_DIR}/${APP_NAME}"
    xcrun stapler validate "${OUT_DIR}/${APP_NAME}"

    echo "---"
    spctl --assess --type execute --verbose=4 "${OUT_DIR}/${APP_NAME}" 2>&1
fi

# Clean up remote job files and sign log (keep secrets/entitlements).
ssh "${SSH_OPTS[@]}" -o ConnectTimeout=10 "${SSH_TARGET}" \
    "rm -f ${REMOTE_INPUT} ${REMOTE_OUTPUT} ${REMOTE_LOG}" 2>/dev/null || true

echo
echo "result: ${OUT_DIR}/${APP_NAME}"
if [[ -n "${SUBMISSION_ID:-}" ]]; then
    echo "notarization submission: ${SUBMISSION_ID}"
fi

# --- Auto-generate DMG if create-dmg.sh exists ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
if [[ -f "${ROOT_DIR}/scripts/create-dmg.sh" ]]; then
    echo
    echo "=> Wrapping in DMG..."
    DMG_NAME="OpenDesk-$(date +%Y%m%d)-arm64.dmg"
    bash "${ROOT_DIR}/scripts/create-dmg.sh" "${OUT_DIR}/${APP_NAME}" "${ROOT_DIR}/${DMG_NAME}"
    echo "DMG: ${ROOT_DIR}/${DMG_NAME}"
fi

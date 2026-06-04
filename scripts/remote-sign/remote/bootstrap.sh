#!/usr/bin/env bash
# One-time setup on the tcloud Linux host. Run as the user that will own jobs (NOT root).
#
#   bash bootstrap.sh
#
# Idempotent.

set -euo pipefail

RCODESIGN_VERSION="0.29.0"
INSTALL_PREFIX="${HOME}/.local/bin"
WORK_ROOT="${HOME}/sign-server"

# Pick the right tarball for the host arch.
case "$(uname -m)" in
    x86_64)  ARCH_TAG="x86_64-unknown-linux-musl" ;;
    aarch64) ARCH_TAG="aarch64-unknown-linux-musl" ;;
    *)       echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "${INSTALL_PREFIX}" "${WORK_ROOT}/jobs" "${WORK_ROOT}/secrets" "${WORK_ROOT}/entitlements"
chmod 700 "${WORK_ROOT}/secrets"

if ! command -v rcodesign >/dev/null 2>&1 || \
   [[ "$(rcodesign --version 2>/dev/null | awk '{print $2}')" != "${RCODESIGN_VERSION}" ]]; then
    TARBALL="apple-codesign-${RCODESIGN_VERSION}-${ARCH_TAG}.tar.gz"
    URL="https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F${RCODESIGN_VERSION}/${TARBALL}"
    echo "installing rcodesign ${RCODESIGN_VERSION} from ${URL}"
    tmp="$(mktemp -d)"
    trap "rm -rf '${tmp}'" EXIT
    curl -fL "${URL}" -o "${tmp}/${TARBALL}"
    tar -xzf "${tmp}/${TARBALL}" -C "${tmp}"
    install -m 0755 "${tmp}/apple-codesign-${RCODESIGN_VERSION}-${ARCH_TAG}/rcodesign" "${INSTALL_PREFIX}/rcodesign"
fi

echo
echo "rcodesign: $(${INSTALL_PREFIX}/rcodesign --version)"
echo "work root: ${WORK_ROOT}"
echo
echo "next steps:"
echo "  1. scp your cert.p12 to ${WORK_ROOT}/secrets/cert.p12   (chmod 600)"
echo "  2. scp your AuthKey_<KEYID>.p8 to ${WORK_ROOT}/secrets/api_key.p8   (chmod 600)"
echo "  3. write ${WORK_ROOT}/secrets/env with the variables listed in INFO.md   (chmod 600)"
echo "  4. scp the four entitlements/*.plist files to ${WORK_ROOT}/entitlements/"
echo "  5. scp sign-once.sh next to ${WORK_ROOT}/"
echo
echo "make sure ${INSTALL_PREFIX} is in PATH:"
echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && source ~/.bashrc"

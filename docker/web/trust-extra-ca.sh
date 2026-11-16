# Copyright (c) 2026 The OpenDesk Team
# OpenDesk is licensed under Mulan PSL v2.
# You can use this software according to the terms and conditions of the Mulan PSL v2.
# You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
# THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
# EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
# MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
# See the Mulan PSL v2 for more details.

# 由 entrypoint 以 `.` 加载。OPENDESK_EXTRA_CA_CERTS 指向 PEM 文件或目录（*.pem / *.crt）时，
# 让容器内各类 TLS 客户端都信任这些 CA（例如公司网络做 TLS 拦截用的根证书）：
#   - Chromium（Electron 主进程的 net / session.fetch、插件 network.fetch）：Linux 上只认自带根证书与
#     用户 NSS 库 ~/.pki/nssdb，不读 NODE_EXTRA_CA_CERTS 和 /etc/ssl/certs，因此导入 NSS 库；
#   - Node.js：NODE_EXTRA_CA_CERTS；
#   - curl / OpenSSL / Python / git / pip：系统根证书 + 额外 CA 合并成一个包，避免只认公司 CA 后访问公网失败。
# 已显式设置的环境变量不覆盖。任何一步失败只打印警告，不阻止 OpenDesk 启动。

opendesk_ca_warn() {
    echo "[opendesk] extra CA: $*" >&2
}

opendesk_trust_extra_ca() {
    ca_source="${OPENDESK_EXTRA_CA_CERTS:-}"
    [ -n "$ca_source" ] || return 0

    ca_work="${XDG_CACHE_HOME:-$HOME/.cache}/opendesk-ca"
    mkdir -p "$ca_work" || { opendesk_ca_warn "cannot create $ca_work"; return 0; }
    ca_extra="$ca_work/extra-ca.pem"

    if [ -d "$ca_source" ]; then
        find "$ca_source" -maxdepth 1 -type f \( -name '*.pem' -o -name '*.crt' \) -print | sort | while IFS= read -r ca_file; do
            cat "$ca_file"
            echo
        done >"$ca_extra"
    elif [ -f "$ca_source" ]; then
        cat "$ca_source" >"$ca_extra"
    else
        opendesk_ca_warn "OPENDESK_EXTRA_CA_CERTS=$ca_source does not exist, skipped"
        return 0
    fi

    rm -f "$ca_work"/cert-*.pem
    awk -v dir="$ca_work" '
        /-----BEGIN CERTIFICATE-----/ { n++; out = sprintf("%s/cert-%03d.pem", dir, n) }
        out { print > out }
        /-----END CERTIFICATE-----/ { close(out); out = "" }
    ' "$ca_extra"
    ca_count=$(find "$ca_work" -maxdepth 1 -name 'cert-*.pem' | wc -l | tr -d ' ')
    if [ "$ca_count" -eq 0 ]; then
        opendesk_ca_warn "no PEM certificate found in $ca_source, skipped"
        return 0
    fi

    # Chromium：导入用户 NSS 库（昵称 opendesk-extra-ca-N，每次启动先删除上次导入的再重新导入）
    ca_nss_dir="$HOME/.pki/nssdb"
    ca_nss="sql:$ca_nss_dir"
    mkdir -p "$ca_nss_dir"
    if [ ! -f "$ca_nss_dir/cert9.db" ]; then
        certutil -N -d "$ca_nss" --empty-password >/dev/null 2>&1 || opendesk_ca_warn "cannot create NSS database"
    fi
    certutil -L -d "$ca_nss" 2>/dev/null | awk '/^opendesk-extra-ca-/ { print $1 }' | while IFS= read -r ca_nick; do
        certutil -D -d "$ca_nss" -n "$ca_nick" >/dev/null 2>&1
    done
    ca_index=0
    for ca_cert in "$ca_work"/cert-*.pem; do
        ca_index=$((ca_index + 1))
        certutil -A -d "$ca_nss" -t "C,," -n "opendesk-extra-ca-$ca_index" -i "$ca_cert" >/dev/null 2>&1 ||
            opendesk_ca_warn "cannot import $(basename "$ca_cert") into NSS"
    done

    # Node.js
    export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$ca_extra}"

    # curl / OpenSSL / Python / git / pip：系统根证书 + 额外 CA
    ca_bundle="$ca_work/ca-bundle.pem"
    cat /etc/ssl/certs/ca-certificates.crt "$ca_extra" >"$ca_bundle" 2>/dev/null || cp "$ca_extra" "$ca_bundle"
    export SSL_CERT_FILE="${SSL_CERT_FILE:-$ca_bundle}"
    export REQUESTS_CA_BUNDLE="${REQUESTS_CA_BUNDLE:-$ca_bundle}"
    export CURL_CA_BUNDLE="${CURL_CA_BUNDLE:-$ca_bundle}"
    export GIT_SSL_CAINFO="${GIT_SSL_CAINFO:-$ca_bundle}"
    export PIP_CERT="${PIP_CERT:-$ca_bundle}"

    opendesk_ca_warn "trusting $ca_count extra CA certificate(s) from $ca_source"
}

/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { BlockList, isIP } from 'node:net';

const overridableErrors = new Set([
    'ERR_CERT_AUTHORITY_INVALID',
    'ERR_CERT_COMMON_NAME_INVALID',
    'ERR_CERT_DATE_INVALID'
]);

export function isOverridableCertificateError(error: string): boolean {
    return overridableErrors.has(error.replace(/^net::/, ''));
}
const localAddresses = new BlockList();
localAddresses.addSubnet('10.0.0.0', 8);
localAddresses.addSubnet('100.64.0.0', 10);
localAddresses.addSubnet('127.0.0.0', 8);
localAddresses.addSubnet('169.254.0.0', 16);
localAddresses.addSubnet('172.16.0.0', 12);
localAddresses.addSubnet('192.168.0.0', 16);
localAddresses.addAddress('::1', 'ipv6');
localAddresses.addSubnet('fc00::', 7, 'ipv6');
localAddresses.addSubnet('fe80::', 10, 'ipv6');

function localHttpsUrl(url: string): URL | undefined {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return;
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return;
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const ipVersion = isIP(hostname);
    // Electron forwards the certificate event without Chromium's HSTS strict-enforcement flag.
    // Restrict manual exceptions to local IP literals, which are outside HSTS.
    if (!ipVersion || !localAddresses.check(hostname, ipVersion === 6 ? 'ipv6' : 'ipv4')) return;
    parsed.hash = '';
    return parsed;
}

interface CertificateFailure {
    error: string;
    fingerprint: string;
}

interface CertificateChallenge extends CertificateFailure {
    url: string;
    confirmedUntil?: number;
}

export class BrowserCertificateExceptions<Guest extends object> {
    private readonly challenges = new WeakMap<Guest, CertificateChallenge>();
    private readonly remembered = new Map<string, CertificateFailure>();

    handleError(guest: Guest, url: string, error: string, fingerprint: string): boolean {
        const target = localHttpsUrl(url);
        const code = error.replace(/^net::/, '');
        if (target && this.matchesRememberedException(target.origin, code, fingerprint)) {
            this.challenges.delete(guest);
            return true;
        }
        if (!target || !overridableErrors.has(code) || !fingerprint) {
            this.challenges.delete(guest);
            return false;
        }
        const current = this.challenges.get(guest);
        if (
            current?.confirmedUntil &&
            current.confirmedUntil > Date.now() &&
            current.url === target.href &&
            current.error === code &&
            current.fingerprint === fingerprint
        ) {
            this.challenges.delete(guest);
            this.remembered.set(target.origin, { error: code, fingerprint });
            return true;
        }
        this.challenges.set(guest, { url: target.href, error: code, fingerprint });
        return false;
    }

    allowsSubresource(pageUrl: string, url: string, error: string, fingerprint: string): boolean {
        const target = localHttpsUrl(url);
        return (
            !!target &&
            localHttpsUrl(pageUrl)?.origin === target.origin &&
            this.matchesRememberedException(target.origin, error.replace(/^net::/, ''), fingerprint)
        );
    }

    private matchesRememberedException(origin: string, error: string, fingerprint: string): boolean {
        const remembered = this.remembered.get(origin);
        if (!remembered) return false;
        if (remembered.error === error && remembered.fingerprint === fingerprint) return true;
        this.remembered.delete(origin);
        return false;
    }

    canContinue(guest: Guest, url: string): boolean {
        const current = this.challenges.get(guest);
        return !!current && current.url === localHttpsUrl(url)?.href;
    }

    confirm(guest: Guest, url: string): boolean {
        const current = this.challenges.get(guest);
        if (!current || current.url !== localHttpsUrl(url)?.href) return false;
        current.confirmedUntil = Date.now() + 15_000;
        return true;
    }

    navigationStarted(guest: Guest, url: string): void {
        const current = this.challenges.get(guest);
        if (current?.confirmedUntil && current.url === localHttpsUrl(url)?.href) return;
        this.challenges.delete(guest);
    }
}

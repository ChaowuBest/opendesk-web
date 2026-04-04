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

/**
 * Ed25519 设备身份管理。
 * 为本网关生成并持久化密钥对，验证客户端设备签名。
 * 与 OpenClaw Gateway 的 device-identity / device-auth 逻辑完全兼容。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GatewayIdentity } from './common.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// ── Base64url helpers ───────────────────────────────────────────────────────

export function base64UrlEncode(buf: Buffer): string {
    return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

export function base64UrlDecode(input: string): Buffer {
    const normalized = input.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, 'base64');
}

// ── Key derivation ──────────────────────────────────────────────────────────

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
    const key = crypto.createPublicKey(publicKeyPem);
    const spki = key.export({ type: 'spki', format: 'der' }) as Buffer;
    if (
        spki.length === ED25519_SPKI_PREFIX.length + 32 &&
        spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
    ) {
        return spki.subarray(ED25519_SPKI_PREFIX.length);
    }
    return spki;
}

export function fingerprintPublicKey(publicKeyPem: string): string {
    const raw = derivePublicKeyRaw(publicKeyPem);
    return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * 从公钥（PEM 或 raw base64url）派生 Device ID（SHA256 hex 指纹）。
 */
export function deriveDeviceId(publicKey: string): string | null {
    try {
        const raw = publicKey.includes('BEGIN') ? derivePublicKeyRaw(publicKey) : base64UrlDecode(publicKey);
        if (raw.length === 0) return null;
        return crypto.createHash('sha256').update(raw).digest('hex');
    } catch {
        return null;
    }
}

// ── Identity persistence ────────────────────────────────────────────────────

type StoredIdentity = {
    version: 1;
    deviceId: string;
    publicKeyPem: string;
    privateKeyPem: string;
    createdAtMs: number;
};

function generateIdentity(): GatewayIdentity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const deviceId = fingerprintPublicKey(publicKeyPem);
    return { deviceId, publicKeyPem, privateKeyPem };
}

/**
 * 加载或生成网关 Ed25519 身份。密钥存储在 dataDir/identity/device.json。
 */
export function loadOrCreateGatewayIdentity(dataDir: string): GatewayIdentity {
    const filePath = path.join(dataDir, 'identity', 'device.json');

    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw) as StoredIdentity;
            if (
                parsed?.version === 1 &&
                typeof parsed.deviceId === 'string' &&
                typeof parsed.publicKeyPem === 'string' &&
                typeof parsed.privateKeyPem === 'string'
            ) {
                return {
                    deviceId: parsed.deviceId,
                    publicKeyPem: parsed.publicKeyPem,
                    privateKeyPem: parsed.privateKeyPem
                };
            }
        }
    } catch {
        // fall through to regenerate
    }

    const identity = generateIdentity();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const stored: StoredIdentity = {
        version: 1,
        deviceId: identity.deviceId,
        publicKeyPem: identity.publicKeyPem,
        privateKeyPem: identity.privateKeyPem,
        createdAtMs: Date.now()
    };
    fs.writeFileSync(filePath, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
    return identity;
}

// ── Signature verification ──────────────────────────────────────────────────

/**
 * 验证客户端 Ed25519 签名。publicKey 可以是 PEM 格式或 raw base64url。
 */
export function verifyDeviceSignature(publicKey: string, payload: string, signatureBase64Url: string): boolean {
    try {
        const key = publicKey.includes('BEGIN')
            ? crypto.createPublicKey(publicKey)
            : crypto.createPublicKey({
                  key: Buffer.concat([ED25519_SPKI_PREFIX, base64UrlDecode(publicKey)]),
                  type: 'spki',
                  format: 'der'
              });
        const sig = (() => {
            try {
                return base64UrlDecode(signatureBase64Url);
            } catch {
                return Buffer.from(signatureBase64Url, 'base64');
            }
        })();
        return crypto.verify(null, Buffer.from(payload, 'utf8'), key, sig);
    } catch {
        return false;
    }
}

// ── Auth payload construction ───────────────────────────────────────────────

export type DeviceAuthPayloadV3Params = {
    deviceId: string;
    clientId: string;
    clientMode: string;
    role: string;
    scopes: string[];
    signedAtMs: number;
    token?: string | null;
    nonce: string;
    platform?: string | null;
    deviceFamily?: string | null;
};

/**
 * 构建 V3 签名 payload 字符串，格式与 OpenClaw 完全一致。
 */
export function buildDeviceAuthPayloadV3(params: DeviceAuthPayloadV3Params): string {
    const scopes = params.scopes.join(',');
    const token = params.token ?? '';
    const platform = (params.platform ?? '').replace(/\|/g, '');
    const deviceFamily = (params.deviceFamily ?? '').replace(/\|/g, '');
    return [
        'v3',
        params.deviceId,
        params.clientId,
        params.clientMode,
        params.role,
        scopes,
        String(params.signedAtMs),
        token,
        params.nonce,
        platform,
        deviceFamily
    ].join('|');
}

/**
 * 构建 V2 签名 payload 字符串（向后兼容）。
 */
export function buildDeviceAuthPayloadV2(params: Omit<DeviceAuthPayloadV3Params, 'platform' | 'deviceFamily'>): string {
    const scopes = params.scopes.join(',');
    const token = params.token ?? '';
    return [
        'v2',
        params.deviceId,
        params.clientId,
        params.clientMode,
        params.role,
        scopes,
        String(params.signedAtMs),
        token,
        params.nonce
    ].join('|');
}

/**
 * 生成随机 nonce 字符串。
 */
export function generateNonce(): string {
    return base64UrlEncode(crypto.randomBytes(32));
}

/**
 * 生成配对 token。
 */
export function generatePairingToken(): string {
    return crypto.randomBytes(32).toString('base64url');
}

/**
 * 常量时间比较两个字符串（防时序攻击）。
 */
export function safeEqual(a: string, b: string): boolean {
    if (a.length === 0 || b.length === 0) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
        return false;
    }
}

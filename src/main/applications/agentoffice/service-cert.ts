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
 * 本地网络服务的自签名证书现场生成器。
 *
 * 只用 node:crypto 手写最小化的 X.509 v3 DER 编码（RSA-2048 + SHA-256），
 * 避免为此引入 forge 类重依赖。证书用途限定 serverAuth，SAN 覆盖监听地址
 * 以及本机回环别名；自签名证书在客户端必然触发"不受信任"提示，属于预期行为。
 */

import crypto from 'crypto';
import net from 'net';

export interface ServiceCertificate {
    /** PEM（PKCS#8）私钥 */
    key: string;
    /** PEM 证书 */
    cert: string;
}

/** 持久化的证书记录：host 用于判断监听地址变化后是否需要重新签发 */
export interface StoredServiceCertificate extends ServiceCertificate {
    host: string;
}

const SIGNATURE_ALGORITHM_OID = '1.2.840.113549.1.1.11'; // sha256WithRSAEncryption
const COMMON_NAME_OID = '2.5.4.3';
const BASIC_CONSTRAINTS_OID = '2.5.29.19';
const KEY_USAGE_OID = '2.5.29.15';
const SUBJECT_ALT_NAME_OID = '2.5.29.17';
const EXTENDED_KEY_USAGE_OID = '2.5.29.37';
const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1';
const COMMON_NAME = 'OpenDesk';
/** 与 Apple 平台对证书有效期上限保持一致，自签名场景下无实质约束 */
const CERTIFICATE_VALIDITY_DAYS = 825;
const CLOCK_SKEW_TOLERANCE_MS = 24 * 60 * 60 * 1000;

// ---------- 最小 DER 编码（仅覆盖 X.509 需要的标签） ----------

function concat(chunks: readonly Uint8Array[]): Uint8Array {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

function derEncode(tag: number, content: Uint8Array): Uint8Array {
    if (content.length < 0x80) {
        return Uint8Array.of(tag, content.length, ...content);
    }
    const lengthBytes: number[] = [];
    let value = content.length;
    while (value > 0) {
        lengthBytes.unshift(value & 0xff);
        value >>>= 8;
    }
    return Uint8Array.of(tag, 0x80 | lengthBytes.length, ...lengthBytes, ...content);
}

function derSequence(...children: readonly Uint8Array[]): Uint8Array {
    return derEncode(0x30, concat(children));
}

function derSet(...children: readonly Uint8Array[]): Uint8Array {
    return derEncode(0x31, concat(children));
}

function derNull(): Uint8Array {
    return Uint8Array.of(0x05, 0x00);
}

function derBooleanTrue(): Uint8Array {
    return Uint8Array.of(0x01, 0x01, 0xff);
}

/** 上下文相关的显式标签（constructed | tagNumber） */
function derExplicit(tagNumber: number, content: Uint8Array): Uint8Array {
    return derEncode(0xa0 | tagNumber, content);
}

function derIntegerFromBytes(bytes: Uint8Array): Uint8Array {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    const trimmed = bytes.subarray(start);
    // 最高位为 1 会被当作负数，补一个前导 0
    return derEncode(0x02, trimmed[0] & 0x80 ? Uint8Array.of(0x00, ...trimmed) : trimmed);
}

function derOid(oid: string): Uint8Array {
    const arcs = oid.split('.').map(Number);
    const body: number[] = [arcs[0] * 40 + arcs[1]];
    for (const arc of arcs.slice(2)) {
        const encoded: number[] = [arc & 0x7f];
        let value = arc >>> 7;
        while (value > 0) {
            encoded.unshift(0x80 | (value & 0x7f));
            value >>>= 7;
        }
        body.push(...encoded);
    }
    return derEncode(0x06, Uint8Array.from(body));
}

function derUtf8String(text: string): Uint8Array {
    return derEncode(0x0c, new TextEncoder().encode(text));
}

function derUtcTime(date: Date): Uint8Array {
    const pad = (value: number) => String(value).padStart(2, '0');
    const text =
        `${String(date.getUTCFullYear()).slice(2)}` +
        `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
        `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
    return derEncode(0x17, new TextEncoder().encode(text));
}

function derBitString(content: Uint8Array): Uint8Array {
    // 首字节为末字节未用位数，这里内容恒为整字节
    return derEncode(0x03, Uint8Array.of(0x00, ...content));
}

function derOctetString(content: Uint8Array): Uint8Array {
    return derEncode(0x04, content);
}

function toPem(der: Uint8Array, label: string): string {
    const base64 = Buffer.from(der).toString('base64');
    const lines = base64.match(/.{1,64}/g) ?? [];
    return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

// ---------- X.509 结构 ----------

function derName(): Uint8Array {
    const commonName = derSet(derSequence(derOid(COMMON_NAME_OID), derUtf8String(COMMON_NAME)));
    return derSequence(commonName);
}

function derSerialNumber(): Uint8Array {
    const bytes = crypto.randomBytes(16);
    bytes[0] &= 0x7f;
    return derIntegerFromBytes(bytes);
}

function signatureAlgorithm(): Uint8Array {
    return derSequence(derOid(SIGNATURE_ALGORITHM_OID), derNull());
}

/** SAN：监听地址（IPv4 用 iPAddress，主机名用 dNSName）+ 本机回环别名 */
function subjectAltNames(host: string): Uint8Array {
    const names: Uint8Array[] = [];
    const pushDns = (value: string) => names.push(derEncode(0x82, new TextEncoder().encode(value)));
    const pushIpv4 = (value: string) =>
        names.push(derEncode(0x87, Uint8Array.from(value.split('.').map((part) => Number(part)))));
    if (net.isIP(host) === 4) pushIpv4(host);
    else if (net.isIP(host) === 0) pushDns(host);
    // 回环别名始终一并签入，本机无论用 localhost 还是 127.0.0.1 访问都能匹配
    if (host !== 'localhost') pushDns('localhost');
    if (host !== '127.0.0.1') pushIpv4('127.0.0.1');
    return derSequence(...names);
}

function extensions(host: string): Uint8Array {
    const basicConstraints = derSequence(
        derOid(BASIC_CONSTRAINTS_OID),
        derBooleanTrue(),
        derOctetString(derSequence())
    );
    // digitalSignature + keyEncipherment（位 0 与位 2）
    const keyUsage = derSequence(
        derOid(KEY_USAGE_OID),
        derBooleanTrue(),
        derOctetString(derEncode(0x03, Uint8Array.of(5, 0xa0)))
    );
    const altNames = derSequence(derOid(SUBJECT_ALT_NAME_OID), derOctetString(subjectAltNames(host)));
    const serverAuth = derSequence(
        derOid(EXTENDED_KEY_USAGE_OID),
        derOctetString(derSequence(derOid(SERVER_AUTH_OID)))
    );
    return derExplicit(3, derSequence(basicConstraints, keyUsage, altNames, serverAuth));
}

/**
 * 现场生成一张自签名服务器证书（RSA-2048 / SHA-256，v3，带 SAN 与 serverAuth）。
 * 生成即返回 PEM；调用方可选择持久化以便重启后复用同一张证书。
 */
export function generateSelfSignedServiceCertificate(host: string): ServiceCertificate {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const notBefore = new Date(Date.now() - CLOCK_SKEW_TOLERANCE_MS);
    const notAfter = new Date(Date.now() + CERTIFICATE_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
    const spki = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }));

    const tbsCertificate = derSequence(
        derExplicit(0, derIntegerFromBytes(Uint8Array.of(2))),
        derSerialNumber(),
        signatureAlgorithm(),
        derName(),
        derSequence(derUtcTime(notBefore), derUtcTime(notAfter)),
        derName(),
        spki,
        extensions(host)
    );
    const signature = crypto.sign('sha256', tbsCertificate, privateKey);
    const certificateDer = derSequence(tbsCertificate, signatureAlgorithm(), derBitString(signature));

    return {
        key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        cert: toPem(certificateDer, 'CERTIFICATE')
    };
}

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

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SignatureInspection {
    status: string;
    subject: string;
}

export interface VerifyUpdateInstallerOptions {
    installerPath: string;
    sha256?: string;
    allowUnverified: boolean;
    trustMode?: 'strict' | 'trusted-source';
    trustedSignerSubjects?: string[];
    inspectSignature?: (installerPath: string) => Promise<SignatureInspection>;
}

async function calculateSha256(filePath: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex');
}

export async function inspectAuthenticodeSignature(installerPath: string): Promise<SignatureInspection> {
    const script = [
        '$ErrorActionPreference = "Stop"',
        '$installerPath = [Environment]::GetEnvironmentVariable("OPENDESK_UPDATE_SIGNATURE_PATH", "Process")',
        '$signature = Get-AuthenticodeSignature -LiteralPath $installerPath',
        '$subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { "" }',
        '[pscustomobject]@{ status = [string]$signature.Status; subject = $subject } | ConvertTo-Json -Compress'
    ].join('; ');
    // 显式标注为 ProcessEnv，保留可索引/可删除的键值签名（spread 后会被收窄成单个已知键）
    const childEnvironment: NodeJS.ProcessEnv = { ...process.env, OPENDESK_UPDATE_SIGNATURE_PATH: installerPath };
    for (const key of Object.keys(childEnvironment)) {
        if (key.toLowerCase() === 'psmodulepath') delete childEnvironment[key];
    }
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 30_000,
        env: childEnvironment
    });
    return JSON.parse(stdout.trim()) as SignatureInspection;
}

export async function verifyUpdateInstaller(options: VerifyUpdateInstallerOptions): Promise<string> {
    const actual = await calculateSha256(options.installerPath);
    // The test release currently trusts the configured download source. Keep calculating a
    // content identifier for the service protocol, but do not enforce feed hashes or signatures.
    if (options.trustMode === 'trusted-source') return actual;
    if (options.sha256) {
        if (actual.toLowerCase() !== options.sha256.toLowerCase()) {
            throw new Error('Update installer checksum verification failed');
        }
        return actual;
    }

    const inspectSignature = options.inspectSignature ?? inspectAuthenticodeSignature;
    const signature = await inspectSignature(options.installerPath);
    if (signature.status === 'Valid') {
        const trustedSubjects = options.trustedSignerSubjects ?? ['OpenDesk'];
        if (trustedSubjects.some((expected) => signature.subject.toLowerCase().includes(expected.toLowerCase())))
            return actual;
        throw new Error(`Update installer signer is not trusted: ${signature.subject || 'unknown'}`);
    }
    if (options.allowUnverified) return actual;
    throw new Error(`Update installer signature verification failed: ${signature.status}`);
}

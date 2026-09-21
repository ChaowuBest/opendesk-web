import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectAuthenticodeSignature, verifyUpdateInstaller } from '../../../../main/updater/verification.js';

test(
    'inspectAuthenticodeSignature passes a spaced installer path to PowerShell',
    { skip: process.platform !== 'win32' },
    async (t) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk updater verification '));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const installerPath = path.join(root, 'signed Windows executable.exe');
        fs.copyFileSync(
            path.join(
                process.env.SystemRoot ?? 'C:\\Windows',
                'System32',
                'WindowsPowerShell',
                'v1.0',
                'powershell.exe'
            ),
            installerPath
        );

        const signature = await inspectAuthenticodeSignature(installerPath);

        assert.equal(signature.status, 'Valid');
        assert.match(signature.subject, /Microsoft/i);
    }
);

test('verifyUpdateInstaller accepts an exact SHA-256 match', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-updater-verification-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const installerPath = path.join(root, 'update.exe');
    fs.writeFileSync(installerPath, 'trusted bytes');
    const sha256 = crypto.createHash('sha256').update('trusted bytes').digest('hex');

    assert.equal(await verifyUpdateInstaller({ installerPath, sha256, allowUnverified: false }), sha256);
});

test('verifyUpdateInstaller rejects a checksum mismatch', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-updater-verification-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const installerPath = path.join(root, 'update.exe');
    fs.writeFileSync(installerPath, 'tampered bytes');

    await assert.rejects(
        verifyUpdateInstaller({ installerPath, sha256: 'a'.repeat(64), allowUnverified: false }),
        /checksum/
    );
});

test('verifyUpdateInstaller trusted-source mode keeps the actual hash but skips checksum and signature enforcement', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-updater-verification-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const installerPath = path.join(root, 'update.exe');
    fs.writeFileSync(installerPath, 'website bytes');
    let inspected = false;

    const actual = await verifyUpdateInstaller({
        installerPath,
        sha256: 'a'.repeat(64),
        allowUnverified: false,
        trustMode: 'trusted-source',
        inspectSignature: async () => {
            inspected = true;
            return { status: 'NotSigned', subject: '' };
        }
    });

    assert.equal(actual, crypto.createHash('sha256').update('website bytes').digest('hex'));
    assert.equal(inspected, false);
});

test('verifyUpdateInstaller requires verification unless the test override is explicit', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-updater-verification-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const installerPath = path.join(root, 'update.exe');
    fs.writeFileSync(installerPath, 'unsigned bytes');
    const inspectSignature = async () => ({ status: 'NotSigned', subject: '' });

    await assert.rejects(
        verifyUpdateInstaller({ installerPath, allowUnverified: false, inspectSignature }),
        /signature/
    );
    assert.equal(
        await verifyUpdateInstaller({ installerPath, allowUnverified: true, inspectSignature }),
        crypto.createHash('sha256').update('unsigned bytes').digest('hex')
    );
});

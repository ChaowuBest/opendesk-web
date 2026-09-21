import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copyLocalInstaller, downloadInstaller } from '../../../../main/updater/download.js';

test('downloadInstaller writes a partial file and atomically completes it', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-updater-download-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const destination = path.join(root, 'OpenDesk-0.3.7-Setup.exe');
    const body = Buffer.from('installer bytes');
    const progress: number[] = [];

    await downloadInstaller({
        url: 'https://updates.example.test/OpenDesk-0.3.7-Setup.exe',
        destination,
        expectedSize: body.length,
        fetchImpl: async () => new Response(body, { headers: { 'content-length': String(body.length) } }),
        onProgress: (received) => progress.push(received)
    });

    assert.equal(fs.readFileSync(destination, 'utf8'), 'installer bytes');
    assert.equal(fs.existsSync(`${destination}.partial`), false);
    assert.equal(progress.at(-1), body.length);
});

test('downloadInstaller permits HTTP only for the temporary update host', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-updater-download-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const destination = path.join(root, 'OpenDesk-0.3.7-Setup.exe');

    await downloadInstaller({
        url: 'http://114.212.84.8:18080/OpenDesk/releases/download/v0.3.7/opendesk-win-x86-0.3.7.exe',
        destination,
        fetchImpl: async () => new Response(Buffer.from('installer bytes'))
    });
    assert.equal(fs.readFileSync(destination, 'utf8'), 'installer bytes');

    await assert.rejects(
        downloadInstaller({
            url: 'http://updates.example.test/OpenDesk-0.3.7-Setup.exe',
            destination,
            fetchImpl: async () => new Response(Buffer.from('unsafe'))
        }),
        /HTTPS/
    );
});

test('downloadInstaller rejects redirects from HTTPS to an untrusted HTTP host', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-updater-download-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const destination = path.join(root, 'OpenDesk-0.3.7-Setup.exe');
    const response = new Response(Buffer.from('unsafe'));
    Object.defineProperty(response, 'url', { value: 'http://updates.example.test/update.exe' });

    await assert.rejects(
        downloadInstaller({
            url: 'https://updates.example.test/OpenDesk-0.3.7-Setup.exe',
            destination,
            fetchImpl: async () => response
        }),
        /HTTPS/
    );
});

test('downloadInstaller leaves no completed installer when the transfer is truncated', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-updater-download-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const destination = path.join(root, 'OpenDesk-0.3.7-Setup.exe');

    await assert.rejects(
        downloadInstaller({
            url: 'https://updates.example.test/OpenDesk-0.3.7-Setup.exe',
            destination,
            expectedSize: 100,
            fetchImpl: async () => new Response(Buffer.from('short'))
        }),
        /size/
    );
    assert.equal(fs.existsSync(destination), false);
});

test('copyLocalInstaller stages a local test package through a partial file', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-updater-local-copy-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source.exe');
    const destination = path.join(root, 'cache', 'OpenDesk-0.3.7-Setup.exe');
    fs.writeFileSync(source, 'local installer');

    await copyLocalInstaller(source, destination);

    assert.equal(fs.readFileSync(destination, 'utf8'), 'local installer');
    assert.equal(fs.existsSync(`${destination}.partial`), false);
});

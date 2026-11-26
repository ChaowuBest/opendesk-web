import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copyLocalInstaller, downloadInstaller } from '../../../../main/updater/download.js';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 产出一个流：先推入给定 chunk，之后既不 close 也不 error（模拟传输挂起） */
function hangingBody(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    const queue = [...chunks];
    return new ReadableStream({
        start(controller) {
            for (const chunk of queue) controller.enqueue(chunk);
        }
    });
}

/** 产出一个慢速但活跃的流：每个 chunk 间隔 intervalMs 后才可拉取 */
function slowActiveBody(count: number, intervalMs: number): ReadableStream<Uint8Array> {
    let remaining = count;
    return new ReadableStream({
        async pull(controller) {
            if (remaining <= 0) {
                controller.close();
                return;
            }
            remaining -= 1;
            await sleep(intervalMs);
            controller.enqueue(new Uint8Array([0x61]));
        }
    });
}

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

test('downloadInstaller rejects HTTP now that the production update feed uses HTTPS', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-updater-download-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const destination = path.join(root, 'OpenDesk-0.3.7-Setup.exe');

    await assert.rejects(
        downloadInstaller({
            url: 'http://114.212.84.8:18080/OpenDesk/releases/download/v0.3.7/opendesk-win-x86-0.3.7.exe',
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

test('downloadInstaller aborts when the transfer stalls with no progress', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-updater-download-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const destination = path.join(root, 'OpenDesk-0.3.7-Setup.exe');

    await assert.rejects(
        downloadInstaller({
            url: 'https://updates.example.test/OpenDesk-0.3.7-Setup.exe',
            destination,
            stallTimeoutMs: 100,
            fetchImpl: async () => new Response(hangingBody([new Uint8Array([1, 2, 3])]))
        }),
        /no progress/
    );
    // 中止后不得留下可被误装的部分文件
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(`${destination}.partial`), false);
});

test('downloadInstaller completes slow-but-active transfers without false stall detection', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-updater-download-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const destination = path.join(root, 'OpenDesk-0.3.7-Setup.exe');

    await downloadInstaller({
        url: 'https://updates.example.test/OpenDesk-0.3.7-Setup.exe',
        destination,
        stallTimeoutMs: 250,
        fetchImpl: async () => new Response(slowActiveBody(6, 40))
    });

    assert.equal(fs.readFileSync(destination, 'utf8'), 'aaaaaa');
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

test('copyLocalInstaller accepts a dmg test package when the expected extension is overridden', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-updater-local-copy-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source.dmg');
    const destination = path.join(root, 'cache', 'opendesk-darwin-arm64-0.3.8.dmg');
    fs.writeFileSync(source, 'local dmg');

    // 默认仍按 Windows 的 .exe 校验，macOS 本地测试包需显式传入 .dmg
    await assert.rejects(copyLocalInstaller(source, destination), /\.exe file/);

    await copyLocalInstaller(source, destination, undefined, '.dmg');

    assert.equal(fs.readFileSync(destination, 'utf8'), 'local dmg');
    assert.equal(fs.existsSync(`${destination}.partial`), false);
});

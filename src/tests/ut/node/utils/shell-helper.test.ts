import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDiskUsage } from '../../../../main/utils/shell-helper.js';

test('disk usage runs the host command with literal paths and includes nested hidden files', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-helper-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    // A literal command substitution would create this marker if paths were interpolated unsafely.
    const marker = path.join(root, 'injected');
    const name = process.platform === 'win32' ? "-space [1] ' $data" : `-space [1] ' $(touch "${marker}")\n`;
    const target = path.join(root, name);
    fs.mkdirSync(path.join(target, '.hidden'), { recursive: true });
    const empty = await getDiskUsage(target);
    fs.writeFileSync(path.join(target, '.hidden', 'data.bin'), Buffer.alloc(128 * 1024, 1));
    const usage = await getDiskUsage(target);
    assert.ok(usage.bytes > empty.bytes);
    assert.ok(Number.isSafeInteger(usage.bytes));
    assert.equal(usage.kind, process.platform === 'win32' ? 'apparent' : 'allocated');
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(await getDiskUsage(path.join(root, 'missing')), { bytes: 0, kind: usage.kind });

    if (process.platform !== 'win32') {
        const outside = path.join(root, 'outside');
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, 'large.bin'), Buffer.alloc(1024 * 1024, 1));
        const link = path.join(target, 'link');
        fs.symlinkSync(outside, link);
        const withLink = await getDiskUsage(target);
        // Link metadata may occupy blocks, but the target's MiB must not be traversed.
        assert.ok(withLink.bytes - usage.bytes < 128 * 1024);
    }
});

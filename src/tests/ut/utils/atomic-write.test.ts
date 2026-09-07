import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from '@jest/globals';
import { atomicWriteFile, buildAtomicWriteTmpPath } from '../../../main/utils/temp.js';

let tempDir: string | undefined;

describe('atomic file write', () => {
    afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        tempDir = undefined;
    });

    test('generates a unique tmp path per call so concurrent writers never share one', () => {
        const target = path.join(os.tmpdir(), 'atomic-write-uniqueness-probe.json');
        const seen = new Set<string>();
        for (let i = 0; i < 128; i++) {
            const tmpPath = buildAtomicWriteTmpPath(target);
            expect(tmpPath.startsWith(target)).toBe(true);
            expect(tmpPath.endsWith('.tmp')).toBe(true);
            expect(seen.has(tmpPath)).toBe(false);
            seen.add(tmpPath);
        }
    });

    test('concurrent writes to the same target keep the content integral and leave no tmp leftovers', async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-atomic-write-'));
        const target = path.join(tempDir, 'task_list.json');
        const writers = 16;
        const payloads = Array.from({ length: writers }, (_, i) => `payload-${i}:` + 'x'.repeat(64 * 1024));

        await Promise.all(payloads.map((payload) => atomicWriteFile(target, payload)));

        const finalContent = fs.readFileSync(target, 'utf8');
        expect(payloads).toContain(finalContent);
        const leftovers = fs.readdirSync(tempDir).filter((file) => file.endsWith('.tmp'));
        expect(leftovers).toEqual([]);
    });

    test('cleans up the tmp file when the write fails', async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-atomic-write-'));
        const target = path.join(tempDir, 'missing-dir', 'target.json');

        await expect(atomicWriteFile(target, 'content')).rejects.toThrow();
        expect(fs.readdirSync(tempDir)).toEqual([]);
    });
});

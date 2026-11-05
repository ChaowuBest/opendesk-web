import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExportDestinationHost } from '../../../common/export.js';
import { withExportDestination } from '../../../main/utils/export-destination.js';
import { createLocalExportDestinationHost } from '../../../main/utils/export-local-destination.js';
import { logger } from '../../../main/utils/logger.js';

const request = { suggestedName: 'export.txt', mimeType: 'text/plain', extensions: ['txt'] };

function createHost() {
    const destination = Object.freeze({ id: 'opaque-provider-document', displayName: 'export.txt' });
    const selectDestination = jest.fn<ExportDestinationHost['selectDestination']>(async () => destination);
    const write = jest.fn<ExportDestinationHost['write']>(async () => undefined);
    const commit = jest.fn<ExportDestinationHost['commit']>(async () => ({ displayName: 'export.txt' }));
    const release = jest.fn<ExportDestinationHost['release']>(async () => undefined);
    return { destination, selectDestination, write, commit, release };
}

describe('shared export transaction', () => {
    test('selection cancellation neither generates content nor writes or commits', async () => {
        const host = createHost();
        host.selectDestination.mockResolvedValue(null);
        const generate = jest.fn(() => 'content');

        expect(await withExportDestination(host, request, generate)).toEqual({ canceled: true });
        expect(generate).not.toHaveBeenCalled();
        expect(host.write).not.toHaveBeenCalled();
        expect(host.commit).not.toHaveBeenCalled();
        expect(host.release).not.toHaveBeenCalled();
    });

    test('success waits for provider commit and then releases the opaque destination', async () => {
        const host = createHost();
        let acknowledge!: () => void;
        host.commit.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    acknowledge = () => resolve({ displayName: 'provider-confirmed.txt' });
                })
        );
        let finished = false;
        const exporting = withExportDestination(host, request, () => 'content').then((result) => {
            finished = true;
            return result;
        });
        await new Promise(setImmediate);

        expect(host.write).toHaveBeenCalledWith(host.destination, 'content');
        expect(finished).toBe(false);
        expect(host.release).not.toHaveBeenCalled();
        acknowledge();
        expect(await exporting).toEqual({ canceled: false, receipt: { displayName: 'provider-confirmed.txt' } });
        expect(host.release).toHaveBeenCalledWith(host.destination);
    });

    test.each(['write', 'commit'] as const)('%s rejection cannot become success and still releases', async (phase) => {
        const host = createHost();
        host[phase].mockRejectedValueOnce(new Error('provider denied'));

        await expect(withExportDestination(host, request, () => 'content')).rejects.toThrow('provider denied');

        if (phase === 'write') expect(host.commit).not.toHaveBeenCalled();
        expect(host.release).toHaveBeenCalledTimes(1);
    });

    test('content generation errors also release the selected target', async () => {
        const host = createHost();
        await expect(
            withExportDestination(host, request, () => {
                throw new Error('generation failed');
            })
        ).rejects.toThrow('generation failed');
        expect(host.write).not.toHaveBeenCalled();
        expect(host.commit).not.toHaveBeenCalled();
        expect(host.release).toHaveBeenCalledTimes(1);
    });

    test('cleanup failure preserves the provider result and the original write error', async () => {
        const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
        try {
            const host = createHost();
            host.release.mockRejectedValue(new Error('cleanup failed'));
            expect(await withExportDestination(host, request, () => 'content')).toMatchObject({ canceled: false });
            host.commit.mockRejectedValueOnce(new Error('commit failed'));
            await expect(withExportDestination(host, request, () => 'content')).rejects.toThrow('commit failed');
            expect(warn).toHaveBeenCalledTimes(2);
        } finally {
            warn.mockRestore();
        }
    });
});

describe('local filesystem export host', () => {
    let directory: string;

    beforeEach(async () => {
        directory = await mkdtemp(path.join(tmpdir(), 'opendesk-export-destination-'));
    });

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    test('stages content before atomic commit and releases the handle without deleting the exported file', async () => {
        const target = path.join(directory, 'export.txt');
        await writeFile(target, 'original');
        const host = createLocalExportDestinationHost(async () => target);
        const destination = (await host.selectDestination(request))!;

        await host.write(destination, '导出内容');
        expect(await readFile(target, 'utf8')).toBe('original');
        expect(await host.commit(destination)).toEqual({ displayName: 'export.txt', localPath: target });
        expect(await readFile(target, 'utf8')).toBe('导出内容');
        await host.release(destination);
        await host.release(destination);
        expect(await readdir(directory)).toEqual(['export.txt']);
        await expect(host.write(destination, 'again')).rejects.toThrow('expired');
    });

    test('uncommitted staging is removed and caller-forged handles cannot access a destination', async () => {
        const target = path.join(directory, 'export.txt');
        const host = createLocalExportDestinationHost(async () => target);
        const destination = (await host.selectDestination(request))!;

        await expect(host.write({ ...destination }, 'forged')).rejects.toThrow('expired');
        await host.write(destination, new Uint8Array([1, 2, 3]));
        await host.release(destination);
        expect(await readdir(directory)).toEqual([]);
    });

    test('local host rejects provider URI and opaque-token paths', async () => {
        for (const target of ['content://provider/document/1', 'opendesk-export:token', 'relative.txt']) {
            const host = createLocalExportDestinationHost(async () => target);
            await expect(host.selectDestination(request)).rejects.toThrow('invalid export file path');
        }
    });
});

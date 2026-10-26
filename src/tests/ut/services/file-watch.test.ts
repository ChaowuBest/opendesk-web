import { afterEach, describe, expect, test } from '@jest/globals';
import { mkdtemp, writeFile, appendFile, rename, unlink, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileWatchService, type FileChangeEvent } from '../../../main/services/file-watch/service.js';

const services: FileWatchService[] = [];
const directories: string[] = [];
afterEach(async () => {
    for (const service of services.splice(0)) service.dispose();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), 'od-file-watch-'));
    directories.push(directory);
    const file = path.join(directory, 'target.txt');
    await writeFile(file, 'initial');
    const service = new FileWatchService();
    services.push(service);
    return { directory, file, service };
}

function collector() {
    const events: FileChangeEvent[] = [];
    let resolve: ((event: FileChangeEvent) => void) | undefined;
    return {
        events,
        callback(event: FileChangeEvent) {
            events.push(event);
            resolve?.(event);
            resolve = undefined;
        },
        next() {
            return new Promise<FileChangeEvent>((done, reject) => {
                const timer = setTimeout(() => reject(new Error('No file change callback')), 5000);
                resolve = (event) => {
                    clearTimeout(timer);
                    done(event);
                };
            });
        }
    };
}

describe('FileWatchService with real files', () => {
    test('reports modifications without reporting initial state', async () => {
        const { file, service } = await fixture();
        const observed = collector();
        await service.watch(file, observed.callback);
        expect(observed.events).toEqual([]);
        const changed = observed.next();
        await appendFile(file, '-modified');
        expect(await changed).toEqual({ path: file, type: 'changed' });
    });

    test.each(['rename', 'move'])('reports %s as missing at the original path', async (operation) => {
        const { directory, file, service } = await fixture();
        const observed = collector();
        await service.watch(file, observed.callback);
        const missing = observed.next();
        if (operation === 'rename') await rename(file, path.join(directory, 'renamed.txt'));
        else {
            const destination = path.join(directory, 'destination');
            await mkdir(destination);
            await rename(file, path.join(destination, 'target.txt'));
        }
        expect(await missing).toEqual({ path: file, type: 'missing' });
    });

    test('continues after atomic replacement and after deletion/recreation', async () => {
        const { directory, file, service } = await fixture();
        const observed = collector();
        await service.watch(file, observed.callback);
        const replacement = path.join(directory, 'replacement.txt');
        await writeFile(replacement, 'replacement');
        const replaced = observed.next();
        await rename(replacement, file);
        expect((await replaced).type).toBe('changed');
        const modified = observed.next();
        await appendFile(file, '-after-replacement');
        expect((await modified).type).toBe('changed');
        const missing = observed.next();
        await unlink(file);
        expect((await missing).type).toBe('missing');
        const recreated = observed.next();
        await writeFile(file, 'recreated');
        expect((await recreated).type).toBe('changed');
    });

    test('cancellation is idempotent and does not cancel another registration', async () => {
        const { file, service } = await fixture();
        const cancelled = collector();
        const remaining = collector();
        const subscription = await service.watch(file, cancelled.callback);
        await service.watch(file, remaining.callback);
        expect(subscription.path).toBe(file);
        subscription.dispose();
        subscription.dispose();
        const changed = remaining.next();
        await appendFile(file, '-modified');
        await changed;
        expect(cancelled.events).toEqual([]);
        service.dispose();
        service.dispose();
        await expect(service.watch(file, remaining.callback)).rejects.toThrow('disposed');
    });

    test('rejects missing files, directory targets, and empty paths during registration', async () => {
        const { directory, service } = await fixture();
        await expect(service.watch(path.join(directory, 'absent'), () => {})).rejects.toThrow();
        await expect(service.watch(directory, () => {})).rejects.toThrow('regular file');
        await expect(service.watch('', () => {})).rejects.toThrow();
    });

    test('isolates throwing and rejecting callbacks and forwards their errors', async () => {
        const { file, service } = await fixture();
        const errors: unknown[] = [];
        const observed = collector();
        let reportError!: (error: Error) => void;
        const reported = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('No callback error report')), 5000);
            reportError = (error) => {
                errors.push(error);
                if (errors.length === 2) {
                    clearTimeout(timer);
                    resolve();
                }
            };
        });
        await service.watch(
            file,
            () => {
                throw new Error('sync callback');
            },
            { onError: reportError }
        );
        await service.watch(
            file,
            async () => {
                throw new Error('async callback');
            },
            { onError: reportError }
        );
        await service.watch(file, observed.callback);
        const changed = observed.next();
        await appendFile(file, '-modified');
        await changed;
        await reported;
        expect(errors.map((error) => (error as Error).message).sort()).toEqual(['async callback', 'sync callback']);
    });
});

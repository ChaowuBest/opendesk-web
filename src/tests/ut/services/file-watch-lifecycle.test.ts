import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { FileWatchService as Service } from '../../../main/services/file-watch/service.js';

const initialState = () => ({ dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5, mode: 6, isFile: () => true });
const inspect = jest.fn<() => Promise<ReturnType<typeof initialState>>>();
const nativeWatchers: Array<EventEmitter & { close: ReturnType<typeof jest.fn>; signal: () => void }> = [];
const watch = jest.fn((_directory: string, signal: () => void) => {
    const watcher = Object.assign(new EventEmitter(), { close: jest.fn(), signal });
    nativeWatchers.push(watcher);
    return watcher;
});
jest.unstable_mockModule('node:fs', () => ({ watch }));
jest.unstable_mockModule('node:fs/promises', () => ({ lstat: inspect }));
let FileWatchService: typeof Service;
const services: Service[] = [];
const file = path.resolve('watched-file.txt');
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeAll(async () => {
    ({ FileWatchService } = await import('../../../main/services/file-watch/service.js'));
});
beforeEach(() => {
    inspect.mockReset().mockResolvedValue(initialState());
    watch.mockClear();
    nativeWatchers.length = 0;
});
afterEach(() => {
    for (const service of services.splice(0)) service.dispose();
});
function service() {
    const instance = new FileWatchService();
    services.push(instance);
    return instance;
}

describe('FileWatchService lifecycle', () => {
    test('coalesces directory signals and ignores unchanged metadata', async () => {
        const callback = jest.fn<() => void>();
        await service().watch(file, callback);
        expect(watch.mock.calls[0][0]).toBe(path.dirname(file));
        nativeWatchers[0].signal();
        nativeWatchers[0].signal();
        await settle();
        expect(inspect).toHaveBeenCalledTimes(2);
        expect(callback).not.toHaveBeenCalled();
    });

    test('cancels a check already awaiting metadata without delivering a stale callback', async () => {
        const callback = jest.fn<() => void>();
        const subscription = await service().watch(file, callback);
        let finish!: (state: ReturnType<typeof initialState>) => void;
        inspect.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                })
        );
        nativeWatchers[0].signal();
        await settle();
        subscription.dispose();
        finish({ ...initialState(), size: 99 });
        await settle();
        expect(callback).not.toHaveBeenCalled();
        expect(nativeWatchers[0].close).toHaveBeenCalledTimes(1);
    });

    test('reports a runtime watcher error and releases the registration', async () => {
        const callback = jest.fn<() => void>();
        const onError = jest.fn();
        await service().watch(file, callback, { onError });
        const error = Object.assign(new Error('watch unavailable'), { code: 'ENOSPC' });
        nativeWatchers[0].emit('error', error);
        expect(onError).toHaveBeenCalledWith(error);
        expect(nativeWatchers[0].close).toHaveBeenCalledTimes(1);
        nativeWatchers[0].signal();
        await settle();
        expect(callback).not.toHaveBeenCalled();
    });

    test('does not misreport permission errors as missing files', async () => {
        const callback = jest.fn<() => void>();
        const onError = jest.fn();
        await service().watch(file, callback, { onError });
        const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
        inspect.mockRejectedValueOnce(error);
        nativeWatchers[0].signal();
        await settle();
        expect(onError).toHaveBeenCalledWith(error);
        expect(callback).not.toHaveBeenCalled();
        expect(nativeWatchers[0].close).toHaveBeenCalledTimes(1);
    });

    test('closes a watcher if initial file inspection fails', async () => {
        const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
        inspect.mockRejectedValueOnce(error);
        await expect(service().watch(file, () => {})).rejects.toBe(error);
        expect(nativeWatchers[0].close).toHaveBeenCalledTimes(1);
    });

    test('service disposal also cancels registrations still starting', async () => {
        const instance = service();
        let finish!: (state: ReturnType<typeof initialState>) => void;
        inspect.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                })
        );
        const pending = instance.watch(file, () => {});
        instance.dispose();
        finish(initialState());
        await expect(pending).rejects.toThrow('disposed');
        expect(nativeWatchers[0].close).toHaveBeenCalledTimes(1);
    });
});

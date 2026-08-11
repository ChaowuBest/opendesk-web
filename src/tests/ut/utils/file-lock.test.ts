import { describe, expect, test } from '@jest/globals';
import os from 'os';
import path from 'path';
import { FileLock } from '../../../main/utils/file-lock.js';

describe('FileLock', () => {
    describe('path resolution', () => {
        test('resolves relative paths to absolute', () => {
            const lock = new FileLock('relative/file.json');
            expect(lock.resolved).toBe(path.resolve('relative/file.json'));
            expect(path.isAbsolute(lock.resolved)).toBe(true);
        });

        test('same absolute path shares the same underlying mutex', () => {
            const dir = os.tmpdir();
            const p = path.join(dir, 'shared.json');
            const a = new FileLock(p);
            const b = new FileLock(p);
            expect(a.isLocked()).toBe(false);
            expect(b.isLocked()).toBe(false);

            // Acquire via a, check b sees it locked
            let release!: () => void;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            const acquiring = a.runExclusive(async () => {
                await held;
            });
            // Microtask flush so the lock is acquired before we check
            return Promise.resolve().then(async () => {
                expect(b.isLocked()).toBe(true);
                release();
                await acquiring;
                expect(b.isLocked()).toBe(false);
            });
        });

        test('different path strings resolving to same file share one lock', () => {
            const dir = os.tmpdir();
            const base = path.join(dir, 'nested', 'deep', 'target.json');
            // Construct equivalent paths with . and ..
            const alt1 = path.join(dir, 'nested', 'deep', '.', 'target.json');
            const alt2 = path.join(dir, 'nested', 'deep', '..', 'deep', 'target.json');

            const a = new FileLock(base);
            const b = new FileLock(alt1);
            const c = new FileLock(alt2);

            expect(a.resolved).toBe(b.resolved);
            expect(a.resolved).toBe(c.resolved);

            let release!: () => void;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            const acquiring = a.runExclusive(async () => {
                await held;
            });
            return Promise.resolve().then(async () => {
                expect(b.isLocked()).toBe(true);
                expect(c.isLocked()).toBe(true);
                release();
                await acquiring;
            });
        });
    });

    describe('mutual exclusion', () => {
        test('serializes concurrent calls on the same path', async () => {
            const lock = new FileLock(path.join(os.tmpdir(), 'mutex-test.json'));
            const order: string[] = [];

            let releaseFirst!: () => void;
            const firstCanFinish = new Promise<void>((resolve) => {
                releaseFirst = resolve;
            });

            const first = lock.runExclusive(async () => {
                order.push('first-start');
                await firstCanFinish;
                order.push('first-end');
            });
            const second = lock.runExclusive(async () => {
                order.push('second-start');
                order.push('second-end');
            });

            // Let microtasks settle so first acquires the lock
            await new Promise((r) => setTimeout(r, 5));
            releaseFirst();
            await Promise.all([first, second]);

            expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
        });

        test('allows concurrent calls on different paths', async () => {
            const lockA = new FileLock(path.join(os.tmpdir(), 'file-a.json'));
            const lockB = new FileLock(path.join(os.tmpdir(), 'file-b.json'));

            const order: string[] = [];

            let releaseA!: () => void;
            const aCanFinish = new Promise<void>((resolve) => {
                releaseA = resolve;
            });

            const a = lockA.runExclusive(async () => {
                order.push('a-start');
                await aCanFinish;
                order.push('a-end');
            });
            // B should start immediately since it's a different file
            const b = lockB.runExclusive(async () => {
                order.push('b-start');
                order.push('b-end');
            });

            await new Promise((r) => setTimeout(r, 5));
            releaseA();
            await Promise.all([a, b]);

            // B should complete before A finishes
            expect(order).toEqual(['a-start', 'b-start', 'b-end', 'a-end']);
        });

        test('preserves FIFO ordering for multiple queued operations', async () => {
            const lock = new FileLock(path.join(os.tmpdir(), 'fifo-test.json'));
            const order: string[] = [];

            const tasks = [1, 2, 3, 4, 5].map((n) =>
                lock.runExclusive(async () => {
                    order.push(`task-${n}`);
                })
            );

            await Promise.all(tasks);

            // All tasks should execute in the order they were queued
            expect(order).toEqual(['task-1', 'task-2', 'task-3', 'task-4', 'task-5']);
        });

        test('nested runExclusive on the same lock instance deadlocks-free with separate instances', async () => {
            // Two separate FileLock instances for the same path should still
            // serialize correctly - the second must wait for the first.
            const p = path.join(os.tmpdir(), 'nested-test.json');
            const lock1 = new FileLock(p);
            const lock2 = new FileLock(p);

            const order: string[] = [];

            let release!: () => void;
            const canFinish = new Promise<void>((resolve) => {
                release = resolve;
            });

            const first = lock1.runExclusive(async () => {
                order.push('first');
                await canFinish;
            });
            const second = lock2.runExclusive(async () => {
                order.push('second');
            });

            await new Promise((r) => setTimeout(r, 5));
            expect(order).toEqual(['first']);
            release();
            await Promise.all([first, second]);
            expect(order).toEqual(['first', 'second']);
        });
    });

    describe('error handling', () => {
        test('releases lock when callback throws synchronously', async () => {
            const lock = new FileLock(path.join(os.tmpdir(), 'err-sync.json'));

            await expect(
                lock.runExclusive(async () => {
                    throw new Error('boom');
                })
            ).rejects.toThrow('boom');

            expect(lock.isLocked()).toBe(false);
        });

        test('releases lock when callback returns a rejected promise', async () => {
            const lock = new FileLock(path.join(os.tmpdir(), 'err-async.json'));

            await expect(
                lock.runExclusive(async () => {
                    return Promise.reject(new Error('async boom'));
                })
            ).rejects.toThrow('async boom');

            expect(lock.isLocked()).toBe(false);
        });

        test('allows subsequent acquisition after an error', async () => {
            const lock = new FileLock(path.join(os.tmpdir(), 'err-recover.json'));

            await expect(
                lock.runExclusive(async () => {
                    throw new Error('fail');
                })
            ).rejects.toThrow('fail');

            const result = await lock.runExclusive(async () => 'recovered');
            expect(result).toBe('recovered');
            expect(lock.isLocked()).toBe(false);
        });

        test('propagates the original error without swallowing', async () => {
            const lock = new FileLock(path.join(os.tmpdir(), 'err-propagate.json'));
            const customError = new TypeError('type error');

            await expect(
                lock.runExclusive(async () => {
                    throw customError;
                })
            ).rejects.toBe(customError);
        });
    });

    describe('return values', () => {
        test('returns the value from the callback', async () => {
            const lock = new FileLock(path.join(os.tmpdir(), 'return-value.json'));
            const result = await lock.runExclusive(async () => 42);
            expect(result).toBe(42);
        });

        test('returns undefined when callback returns nothing', async () => {
            const lock = new FileLock(path.join(os.tmpdir(), 'return-void.json'));
            const result = await lock.runExclusive(async () => {});
            expect(result).toBeUndefined();
        });

        test('returns complex objects by reference', async () => {
            const lock = new FileLock(path.join(os.tmpdir(), 'return-obj.json'));
            const obj = { a: 1, b: { c: 2 } };
            const result = await lock.runExclusive(async () => obj);
            expect(result).toBe(obj);
        });
    });

    describe('concurrent stress', () => {
        test('serializes N concurrent increments without lost updates', async () => {
            const p = path.join(os.tmpdir(), 'stress-increment.json');
            let counter = 0;
            const N = 50;

            const tasks = Array.from({ length: N }, () =>
                new FileLock(p).runExclusive(async () => {
                    const current = counter;
                    // Simulate async work to increase chance of race conditions
                    await new Promise((r) => setTimeout(r, 0));
                    counter = current + 1;
                })
            );

            await Promise.all(tasks);

            expect(counter).toBe(N);
        });

        test('different paths run fully in parallel', async () => {
            const paths = Array.from({ length: 10 }, (_, i) => path.join(os.tmpdir(), `parallel-${i}.json`));

            let maxConcurrent = 0;
            let current = 0;

            const tasks = paths.map((p) =>
                new FileLock(p).runExclusive(async () => {
                    current++;
                    maxConcurrent = Math.max(maxConcurrent, current);
                    await new Promise((r) => setTimeout(r, 10));
                    current--;
                })
            );

            await Promise.all(tasks);

            // All 10 should run concurrently since they're different files
            expect(maxConcurrent).toBe(paths.length);
        });

        test('same path with new FileLock instances each time still serializes', async () => {
            const p = path.join(os.tmpdir(), 'stress-new-instances.json');
            const events: number[] = [];
            const N = 20;

            const tasks = Array.from({ length: N }, (_, i) =>
                new FileLock(p).runExclusive(async () => {
                    events.push(i);
                    await new Promise((r) => setTimeout(r, 0));
                })
            );

            await Promise.all(tasks);

            expect(events).toHaveLength(N);
            // Each event should appear exactly once (no lost or duplicated operations)
            expect(new Set(events).size).toBe(N);
        });
    });
});

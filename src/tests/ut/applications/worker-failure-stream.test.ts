import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../../../main/applications/registry.ts', import.meta.url), 'utf8');

function workerFailureFixture() {
    const registry = {
        pendingRequests: new Map<string, { reject(error: Error): void }>(),
        pendingStreamRequests: new Map<string, (chunk: unknown, error?: string) => void>(),
        activeFetchReaders: new Map<string, { cancel(): void }>()
    };
    const start = source.indexOf('    const rejectPendingWorkerRequests = ');
    const end = source.indexOf('    const handleWorkerFailure = ', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = ts.transpileModule(source.slice(start, end), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const fail = runInNewContext(handler + '\nrejectPendingWorkerRequests;', {
        ApplicationRegistry: registry,
        logger: { warn: jest.fn() }
    }) as (error: Error) => void;
    return { registry, fail };
}

describe('global worker crash stream termination', () => {
    test('retains the crash reason and clears every request and active reader', () => {
        const { registry, fail } = workerFailureFixture();
        const reject = jest.fn();
        const stream = jest.fn();
        const cancel = jest.fn();
        registry.pendingRequests.set('call', { reject });
        registry.pendingStreamRequests.set('stream', stream);
        registry.activeFetchReaders.set('fetch', { cancel });
        const crashed = new Error('Worker exited unexpectedly');

        fail(crashed);

        expect(reject).toHaveBeenCalledWith(crashed);
        expect(stream).toHaveBeenCalledWith(undefined, crashed.message);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(registry.pendingRequests.size).toBe(0);
        expect(registry.pendingStreamRequests.size).toBe(0);
        expect(registry.activeFetchReaders.size).toBe(0);
    });

    test('a broken host listener cannot leave other stream clients or readers hanging', () => {
        const { registry, fail } = workerFailureFixture();
        const second = jest.fn();
        const cancel = jest.fn();
        registry.pendingStreamRequests.set('closed-window', () => {
            throw new Error('WebContents destroyed');
        });
        registry.pendingStreamRequests.set('live-window', second);
        registry.activeFetchReaders.set('fetch', { cancel });

        expect(() => fail(new Error('Worker failed'))).not.toThrow();

        expect(second).toHaveBeenCalledWith(undefined, 'Worker failed');
        expect(cancel).toHaveBeenCalled();
        expect(registry.pendingStreamRequests.size).toBe(0);
        expect(registry.activeFetchReaders.size).toBe(0);
    });
});

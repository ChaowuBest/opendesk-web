import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    configureHostRuntime,
    getHostRuntime,
    prepareHostResource,
    prepareHostProcess,
    resolveHostProcessCommand
} from '../../../platforms/runtime.js';
import { asyncShellExec, buildChildProcessEnv, getDefaultShell } from '../../../main/utils/shellExec.js';
import { scanSupportedShells } from '../../../main/applications/terminal/scan.js';
import { shouldUseWasm } from '../../../main/services/storage/platform.js';

test('runtime defaults are restored and host commands preserve argument boundaries', async () => {
    const resources: string[] = [];
    const processes: string[] = [];
    const restore = configureHostRuntime({
        prepareResource: async (name) => {
            resources.push(name);
        },
        prepareProcess: async (kind) => {
            processes.push(kind);
        },
        resolveProcessCommand: (command, args) => ({ command: '/host/launcher', args: [command, ...args] }),
        defaultShell: () => ({ shellPath: '/host/sh', shellArgs: ['-c'] }),
        shells: () => [{ kind: 'bash', path: '/host/sh', sandboxed: false }],
        sqliteBackend: 'wasm'
    });
    try {
        await prepareHostResource('spreadsheet-parser');
        await prepareHostProcess('stdio');
        assert.deepEqual(resources, ['spreadsheet-parser']);
        assert.deepEqual(processes, ['stdio']);
        assert.deepEqual(resolveHostProcessCommand('npx', ['a b', '$literal'], 'stdio'), {
            command: '/host/launcher',
            args: ['npx', 'a b', '$literal']
        });
        assert.deepEqual(getDefaultShell(), { shellPath: '/host/sh', shellArgs: ['-c'] });
        assert.deepEqual(scanSupportedShells('external'), [{ kind: 'bash', path: '/host/sh', sandboxed: false }]);
        assert.equal(shouldUseWasm(), true);
    } finally {
        restore();
    }
    assert.equal(getHostRuntime().sqliteBackend, undefined);
    assert.deepEqual(resolveHostProcessCommand('npx', ['a b'], 'stdio'), { command: 'npx', args: ['a b'] });
});

test('shell execution awaits host preparation and builds a fresh host environment', async () => {
    let ready = false;
    const restore = configureHostRuntime({
        prepareProcess: async () => {
            await Promise.resolve();
            ready = true;
        },
        defaultShell: () => ({ shellPath: '/bin/sh', shellArgs: ['-c'] }),
        transformProcessEnvironment: (environment, explicit) => ({
            ...environment,
            HOST_PORT_PROBE: explicit?.HOST_PORT_PROBE ?? 'host-ready'
        }),
        resolveProcessCommand: (command, args) => {
            assert.equal(ready, true);
            return { command, args: [...args] };
        }
    });
    try {
        assert.equal(buildChildProcessEnv({ HOST_PORT_PROBE: 'caller' }).HOST_PORT_PROBE, 'caller');
        const output = await asyncShellExec('printf "%s" "$HOST_PORT_PROBE"');
        assert.equal(output.stdout, 'host-ready');
    } finally {
        restore();
    }
});

test('resource preparation observes a host installed after static module evaluation', async () => {
    const seen: string[] = [];
    const pending = prepareHostResource('entrypoint-resource');
    const restore = configureHostRuntime({
        prepareResource: (resource) => {
            seen.push(resource);
        }
    });
    try {
        await pending;
        assert.deepEqual(seen, ['entrypoint-resource']);
    } finally {
        restore();
    }
});

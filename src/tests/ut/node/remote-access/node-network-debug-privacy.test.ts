import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

test('real minified ESM bridge keeps raw werift diagnostics out of stdout, stderr and file logs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opendesk-debug-privacy-'));
    try {
        const outfile = join(root, 'bridge.mjs');
        await build({
            entryPoints: [resolve('src/tests/ut/node/remote-access/fixtures/node-debug-privacy.mjs')],
            outfile,
            bundle: true,
            platform: 'node',
            target: 'node20',
            format: 'esm',
            minify: true,
            banner: {
                js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);"
            },
            logLevel: 'silent'
        });
        for (const [index, debug] of ['', 'werift*', '*'].entries()) {
            const profile = join(root, String(index));
            await mkdir(profile);
            const child = spawnSync(process.execPath, [outfile], {
                cwd: root,
                env: {
                    ...process.env,
                    DEBUG: debug,
                    OPENDESK_CONFIG_DIRECTORY: profile,
                    OPENDDESK_CONFIG_DIRECTORY: '',
                    NO_COLOR: '1'
                },
                encoding: 'utf8',
                timeout: 10000,
                maxBuffer: 1024 * 1024
            });
            assert.equal(child.status, 0, `isolated bundled bridge exits normally (${index})`);
            const logDirectory = join(profile, 'logs');
            const files = await readdir(logDirectory);
            const fileLog = (await Promise.all(files.map((file) => readFile(join(logDirectory, file), 'utf8')))).join(
                '\n'
            );
            for (const output of [child.stdout, child.stderr, fileLog]) {
                for (const marker of [
                    'SYNTHETIC_TURN_USER',
                    'SYNTHETIC_TURN_CREDENTIAL',
                    'SYNTHETIC_PRIVATE_SESSION'
                ]) {
                    assert.equal(output.includes(marker), false, `no private marker in bundled output (${index})`);
                }
            }
            assert.ok(child.stderr.includes('SYNTHETIC_OTHER_DEBUG'), 'other dependency debug output remains enabled');
            assert.ok(
                fileLog.includes('[TuiRemoteNetwork] attempt_expired count=1'),
                'safe diagnostics remain available'
            );
            assert.ok(child.stdout.includes('"debugEnvironmentPreserved":true'));
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

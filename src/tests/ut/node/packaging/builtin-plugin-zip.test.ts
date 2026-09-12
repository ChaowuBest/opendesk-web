import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';
import { buildBuiltinPlugins } from '../../../../../scripts/build-builtin-plugins.js';
import { canonicalPluginTreeSha256 } from '../../../../../scripts/lib/builtin-plugin-zip.js';

const FIXED_TIME = new Date('1980-01-01T00:00:00.000Z');

function sha256(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

type PluginFixtureOptions = {
    bundle?: boolean;
    entry?: string;
    indexContent?: string;
    packageJson?: Record<string, unknown>;
};

function writePlugin(root: string, id: string, options: PluginFixtureOptions = {}): void {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
        path.join(root, 'opendesk.plugin.json'),
        `${JSON.stringify(
            {
                schemaVersion: 1,
                id,
                displayName: id,
                entry: options.entry ?? './index.mjs',
                version: '1.0.0',
                apiVersion: 1,
                capabilities: ['hook'],
                ...(options.bundle ? { bundle: true } : {})
            },
            null,
            2
        )}\n`,
        'utf8'
    );
    fs.writeFileSync(
        path.join(root, 'index.mjs'),
        options.indexContent ?? `export default { id: '${id}', setup() {} };\n`,
        'utf8'
    );
    if (options.packageJson) {
        fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(options.packageJson, null, 2)}\n`, 'utf8');
    }
}

function writeArtifact(
    container: string,
    id: string,
    options: {
        mutateZip?: (zip: AdmZip) => void;
        extraContainerFile?: string;
        override?: Record<string, unknown>;
        plugin?: PluginFixtureOptions;
    } = {}
): string {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-packed-plugin-source-'));
    try {
        writePlugin(source, id, options.plugin);
        const zip = new AdmZip();
        const releaseFiles = ['index.mjs', 'opendesk.plugin.json'];
        if (options.plugin?.packageJson) releaseFiles.push('package.json');
        for (const relative of releaseFiles) {
            const entry = zip.addFile(relative, fs.readFileSync(path.join(source, relative)), '', 0o644);
            entry.header.time = FIXED_TIME;
            entry.header.made = 0x0314;
        }
        options.mutateZip?.(zip);
        fs.mkdirSync(container, { recursive: true });
        const archiveName = `${id}.zip`;
        const archivePath = path.join(container, archiveName);
        fs.writeFileSync(archivePath, zip.toBuffer());
        const descriptor = {
            schemaVersion: 1,
            format: 'opendesk-builtin-plugin-zip-v1',
            pluginId: id,
            pluginVersion: '1.0.0',
            projectRepository: 'https://example.com/plugins/project',
            generatorSchemaVersion: 1,
            archive: archiveName,
            archiveSha256: sha256(archivePath),
            archiveBytes: fs.statSync(archivePath).size,
            treeSha256: canonicalPluginTreeSha256(source),
            ...options.override
        };
        fs.writeFileSync(path.join(container, 'artifact-manifest.json'), `${JSON.stringify(descriptor, null, 2)}\n`);
        if (options.extraContainerFile) fs.writeFileSync(path.join(container, options.extraContainerFile), 'extra');
        return archivePath;
    } finally {
        fs.rmSync(source, { recursive: true, force: true });
    }
}

function updateArtifactDescriptor(container: string, update: Record<string, unknown>): void {
    const descriptorPath = path.join(container, 'artifact-manifest.json');
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(descriptorPath, `${JSON.stringify({ ...descriptor, ...update }, null, 2)}\n`, 'utf8');
}

test('builds packaged and expanded builtin plugins through one output contract', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-builtin-zip-valid-'));
    try {
        const source = path.join(root, 'resources', 'plugins');
        writeArtifact(path.join(source, 'packed-plugin'), 'packed-plugin');
        writePlugin(path.join(source, 'expanded-plugin'), 'expanded-plugin');
        const output = path.join(root, 'dist', 'plugins');
        const result = await buildBuiltinPlugins({ sourceDirectory: source, outputDirectory: output });
        assert.deepEqual(result.map((entry) => entry.id).sort(), ['expanded-plugin', 'packed-plugin']);
        assert.equal(fs.existsSync(path.join(output, 'packed-plugin', 'opendesk.plugin.json')), true);
        assert.equal(fs.existsSync(path.join(output, 'packed-plugin.zip')), false);
        assert.equal(fs.existsSync(path.join(output, 'expanded-plugin', 'index.mjs')), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('materializes a packaged release without installing dependencies or rebuilding its entry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-builtin-zip-immutable-'));
    try {
        const source = path.join(root, 'resources', 'plugins');
        const expectedEntry = `export default { id: 'packed-plugin', marker: 'release-bytes' };\n`;
        writeArtifact(path.join(source, 'packed-plugin'), 'packed-plugin', {
            plugin: {
                bundle: true,
                indexContent: expectedEntry,
                packageJson: {
                    name: 'packed-plugin',
                    version: '1.0.0',
                    type: 'module',
                    dependencies: { 'release-only-dependency': '1.0.0' }
                }
            }
        });
        const output = path.join(root, 'dist', 'plugins');
        let npmCalls = 0;

        const result = await buildBuiltinPlugins({
            sourceDirectory: source,
            outputDirectory: output,
            runNpm: async () => {
                npmCalls += 1;
                throw new Error('packaged artifacts must not install dependencies');
            }
        });

        assert.equal(npmCalls, 0);
        assert.equal(result.length, 1);
        assert.equal(fs.readFileSync(result[0].entry, 'utf8'), expectedEntry);
        assert.equal(fs.existsSync(path.join(result[0].outputDirectory, 'package.json')), true);
        assert.equal(fs.existsSync(path.join(result[0].outputDirectory, 'node_modules')), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

for (const bundle of [false, true]) {
    test(`expanded ${bundle ? 'bundle' : 'copy'} installs dependencies and produces an executable entry`, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-expanded-deps-'));
        try {
            const source = path.join(root, 'source');
            const plugin = path.join(source, 'expanded-plugin');
            writePlugin(plugin, 'expanded-plugin', {
                bundle,
                indexContent: "import { value } from 'fixture-dependency'; export default value;\n",
                packageJson: { type: 'module', dependencies: { 'fixture-dependency': '1.0.0' } }
            });
            const calls: Array<{ args: string[]; cwd: string }> = [];
            const built = await buildBuiltinPlugins({
                sourceDirectory: source,
                outputDirectory: path.join(root, 'output'),
                runNpm: async (args, cwd) => {
                    calls.push({ args, cwd });
                    const dependency = path.join(cwd, 'node_modules', 'fixture-dependency');
                    fs.mkdirSync(dependency, { recursive: true });
                    fs.writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }));
                    fs.writeFileSync(path.join(dependency, 'index.js'), 'export const value = 42;');
                }
            });
            assert.equal(calls.length, 1);
            assert.equal(calls[0].cwd, plugin);
            assert.ok(calls[0].args.includes('fixture-dependency@1.0.0'));
            assert.equal(fs.existsSync(path.join(built[0].outputDirectory, 'node_modules')), !bundle);
            assert.equal((await import(pathToFileURL(built[0].entry).href)).default, 42);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}

test('expanded bundle leaves host SDK and its subpaths external', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-expanded-host-'));
    try {
        const source = path.join(root, 'source');
        writePlugin(path.join(source, 'expanded-plugin'), 'expanded-plugin', {
            bundle: true,
            indexContent: "export { definePlugin } from '@bitclub.ai/opendesk-plugin-sdk'; export * from '@bitclub.ai/opendesk-plugin-sdk/testing'; export { z } from 'zod';\n",
            packageJson: { dependencies: { '@bitclub.ai/opendesk-plugin-sdk': '0.0.0', zod: '0.0.0' } }
        });
        const built = await buildBuiltinPlugins({
            sourceDirectory: source,
            outputDirectory: path.join(root, 'output'),
            runNpm: async () => { throw new Error('Host packages must not be installed'); }
        });
        const entry = fs.readFileSync(built[0].entry, 'utf8');
        assert.match(entry, /from["']@bitclub\.ai\/opendesk-plugin-sdk["']/);
        assert.match(entry, /from["']@bitclub\.ai\/opendesk-plugin-sdk\/testing["']/);
        assert.match(entry, /from["']zod["']/);
        assert.equal(fs.existsSync(path.join(built[0].outputDirectory, 'node_modules')), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('rejects expanded plugin entries that are outside the plugin root or missing', async () => {
    for (const scenario of ['outside', 'missing']) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), `opendesk-builtin-entry-${scenario}-`));
        try {
            const source = path.join(root, 'resources', 'plugins');
            writePlugin(path.join(source, 'expanded-plugin'), 'expanded-plugin', {
                entry: scenario === 'outside' ? '../outside.mjs' : './missing.mjs'
            });

            await assert.rejects(
                buildBuiltinPlugins({ sourceDirectory: source, outputDirectory: path.join(root, 'dist', 'plugins') }),
                scenario === 'outside'
                    ? /plugin\.builtin_entry_outside_root:expanded-plugin/
                    : /plugin\.builtin_entry_not_found:expanded-plugin/
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
});

test('rejects archive hash mismatch and leaves no partial plugin directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-builtin-zip-hash-'));
    try {
        const source = path.join(root, 'resources', 'plugins');
        const container = path.join(source, 'packed-plugin');
        const archive = writeArtifact(container, 'packed-plugin');
        fs.appendFileSync(archive, Buffer.from('tampered'));
        const output = path.join(root, 'dist', 'plugins');
        await assert.rejects(
            buildBuiltinPlugins({ sourceDirectory: source, outputDirectory: output }),
            /plugin\.builtin_artifact_archive_size_invalid|plugin\.builtin_artifact_archive_hash_mismatch/
        );
        assert.equal(fs.existsSync(path.join(output, 'packed-plugin')), false);
        assert.equal(
            fs.existsSync(path.join(root, 'dist')) &&
                fs.readdirSync(path.join(root, 'dist')).some((name) => name.startsWith('.plugin-build-')),
            false
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('rejects unsafe and colliding archive paths', async () => {
    for (const scenario of ['traversal', 'absolute', 'backslash', 'reserved', 'case', 'unicode']) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), `opendesk-builtin-zip-${scenario}-`));
        try {
            const source = path.join(root, 'resources', 'plugins');
            writeArtifact(path.join(source, 'packed-plugin'), 'packed-plugin', {
                mutateZip(zip) {
                    const addRenamed = (entryName: string) => {
                        const entry = zip.addFile('unsafe-entry', Buffer.from('bad'), '', 0o644);
                        entry.entryName = entryName;
                    };
                    if (scenario === 'traversal') addRenamed('../escape.mjs');
                    else if (scenario === 'absolute') addRenamed('/absolute.mjs');
                    else if (scenario === 'backslash') addRenamed('nested\\entry.mjs');
                    else if (scenario === 'reserved') addRenamed('con.txt');
                    else if (scenario === 'case') zip.addFile('INDEX.MJS', Buffer.from('bad'), '', 0o644);
                    else {
                        zip.addFile('caf\u00e9.mjs', Buffer.from('one'), '', 0o644);
                        zip.addFile('cafe\u0301.mjs', Buffer.from('two'), '', 0o644);
                    }
                }
            });
            await assert.rejects(
                buildBuiltinPlugins({ sourceDirectory: source, outputDirectory: path.join(root, 'dist', 'plugins') }),
                /plugin\.builtin_artifact_path_invalid|plugin\.builtin_artifact_path_collision/
            );
            assert.equal(fs.existsSync(path.join(root, 'escape.mjs')), false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
});

test('rejects non-regular ZIP entries, unknown container files, and ambiguous source formats', async () => {
    for (const scenario of ['symlink', 'unknown', 'hidden', 'ambiguous']) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), `opendesk-builtin-zip-${scenario}-`));
        try {
            const source = path.join(root, 'resources', 'plugins');
            const container = path.join(source, 'packed-plugin');
            writeArtifact(container, 'packed-plugin', {
                mutateZip(zip) {
                    if (scenario === 'symlink') {
                        const entry = zip.addFile('link', Buffer.from('index.mjs'), '', 0o777);
                        entry.attr = ((0xa000 | 0o777) << 16) >>> 0;
                    }
                },
                extraContainerFile:
                    scenario === 'unknown' ? 'README.md' : scenario === 'hidden' ? '.unreviewed' : undefined
            });
            if (scenario === 'ambiguous') {
                fs.writeFileSync(path.join(container, 'opendesk.plugin.json'), '{}');
            }
            await assert.rejects(
                buildBuiltinPlugins({ sourceDirectory: source, outputDirectory: path.join(root, 'dist', 'plugins') }),
                /plugin\.builtin_artifact_non_regular_entry|plugin\.builtin_artifact_file_set_invalid|plugin\.builtin_source_ambiguous/
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
});

test('reports missing and malformed tracked artifacts without publishing partial output', async () => {
    for (const scenario of ['archive-missing', 'manifest-missing', 'lfs-pointer']) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), `opendesk-builtin-zip-${scenario}-`));
        try {
            const source = path.join(root, 'resources', 'plugins');
            const container = path.join(source, 'packed-plugin');
            const archivePath = writeArtifact(container, 'packed-plugin');
            if (scenario === 'archive-missing') fs.rmSync(archivePath);
            else if (scenario === 'manifest-missing') fs.rmSync(path.join(container, 'artifact-manifest.json'));
            else {
                fs.writeFileSync(archivePath, 'version https://git-lfs.github.com/spec/v1\n', 'utf8');
                updateArtifactDescriptor(container, {
                    archiveSha256: sha256(archivePath),
                    archiveBytes: fs.statSync(archivePath).size
                });
            }
            const output = path.join(root, 'dist', 'plugins');
            await assert.rejects(
                buildBuiltinPlugins({ sourceDirectory: source, outputDirectory: output }),
                /plugin\.builtin_artifact_missing|plugin\.builtin_artifact_archive_invalid/
            );
            assert.equal(fs.existsSync(path.join(output, 'packed-plugin')), false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
});

test('rejects artifact identity mismatches, legacy provenance, and duplicate plugin ids', async () => {
    for (const scenario of ['container', 'version', 'legacy-provenance', 'duplicate']) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), `opendesk-builtin-zip-${scenario}-`));
        try {
            const source = path.join(root, 'resources', 'plugins');
            const containerName = scenario === 'container' ? 'wrong-container' : 'packed-plugin';
            writeArtifact(path.join(source, containerName), 'packed-plugin', {
                override:
                    scenario === 'version'
                        ? { pluginVersion: '2.0.0' }
                        : scenario === 'legacy-provenance'
                          ? {
                                projectRepository: undefined,
                                sourceRepository: 'https://example.com/plugins/source',
                                sourceCommit: 'a'.repeat(40)
                            }
                          : undefined
            });
            if (scenario === 'duplicate') writePlugin(path.join(source, 'expanded-alias'), 'packed-plugin');
            await assert.rejects(
                buildBuiltinPlugins({ sourceDirectory: source, outputDirectory: path.join(root, 'dist', 'plugins') }),
                /plugin\.builtin_artifact_manifest_invalid|plugin\.builtin_artifact_container_mismatch|plugin\.builtin_artifact_identity_mismatch|plugin\.builtin_duplicate_id/
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
});

test('rejects declared archive size and tree hash mismatches', async () => {
    for (const scenario of ['size', 'tree']) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), `opendesk-builtin-zip-${scenario}-`));
        try {
            const source = path.join(root, 'resources', 'plugins');
            writeArtifact(path.join(source, 'packed-plugin'), 'packed-plugin', {
                override: scenario === 'size' ? { archiveBytes: 64 * 1024 * 1024 + 1 } : { treeSha256: 'b'.repeat(64) }
            });
            await assert.rejects(
                buildBuiltinPlugins({ sourceDirectory: source, outputDirectory: path.join(root, 'dist', 'plugins') }),
                /plugin\.builtin_artifact_manifest_invalid|plugin\.builtin_artifact_tree_hash_mismatch/
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
});

test('rejects an archive whose entry count exceeds the hard resource limit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-builtin-zip-entry-limit-'));
    try {
        const source = path.join(root, 'resources', 'plugins');
        writeArtifact(path.join(source, 'packed-plugin'), 'packed-plugin', {
            mutateZip(zip) {
                for (let index = 0; index < 127; index += 1) {
                    zip.addFile(`extra-${index}.txt`, Buffer.from('bounded'), '', 0o644);
                }
            }
        });
        await assert.rejects(
            buildBuiltinPlugins({ sourceDirectory: source, outputDirectory: path.join(root, 'dist', 'plugins') }),
            /plugin\.builtin_artifact_entry_count_invalid/
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

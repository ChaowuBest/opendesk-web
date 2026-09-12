import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

function treeDigest(directory) {
    const hash = crypto.createHash('sha256');
    const visit = (current) => {
        for (const entry of fs
            .readdirSync(current, { withFileTypes: true })
            .sort((a, b) =>
                Buffer.from(a.name.normalize('NFC'), 'utf8').compare(Buffer.from(b.name.normalize('NFC'), 'utf8'))
            )) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) visit(fullPath);
            else {
                const relative = path.relative(directory, fullPath).split(path.sep).join('/').normalize('NFC');
                const fileHash = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
                hash.update(Buffer.from(relative, 'utf8'));
                hash.update(Buffer.from([0]));
                hash.update(fileHash, 'ascii');
                hash.update('\n', 'ascii');
            }
        }
    };
    visit(directory);
    return hash.digest('hex');
}

test('keeps the tracked ZIP artifact identical to dist/plugins', () => {
    const source = path.join(root, 'resources', 'plugins', 'opendesk-wps-slides');
    const built = path.join(root, 'dist', 'plugins', 'opendesk-wps-slides');
    const artifact = JSON.parse(fs.readFileSync(path.join(source, 'artifact-manifest.json'), 'utf8'));
    assert.equal(fs.existsSync(source), true);
    assert.equal(fs.existsSync(built), true);
    assert.deepEqual(fs.readdirSync(source).sort(), ['artifact-manifest.json', 'opendesk-wps-slides.zip']);
    assert.equal(artifact.treeSha256, treeDigest(built));
    assert.equal(fs.existsSync(path.join(built, '.git')), false);
    assert.equal(fs.existsSync(path.join(built, 'opendesk-wps-slides.zip')), false);
});

test('packages standalone CLI and serve with the existing dist/plugins resolver layout', () => {
    const script = fs.readFileSync(path.join(root, 'scripts', 'packaging', 'createCliRelease.sh'), 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.match(script, /mkdir -p "\$RELEASE_DIR\/dist"/);
    assert.match(script, /cp dist\/cli\/opendesk "\$RELEASE_DIR\/opendesk"/);
    assert.match(script, /cp -R dist\/plugins "\$RELEASE_DIR\/dist\/plugins"/);
    assert.match(script, /path\.join\(__dirname, 'opendesk'\)/);
    assert.match(script, /"main": "\.\/opendesk"/);
    assert.match(script, /"opendesk": "\.\/opendesk"/);
    assert.doesNotMatch(script, /\$RELEASE_DIR\/cli\/opendesk/);
    assert.doesNotMatch(script, /cp -R dist\/plugins "\$RELEASE_DIR\/plugins"/);
    assert.doesNotMatch(script, /path\.join\(__dirname, 'cli', 'opendesk'\)/);
    assert.match(packageJson.scripts['build-cli-bun'], /^npm run build:plugins && /);
});

test('enables Electron RunAsNode while preserving external Node for non-Electron hosts', () => {
    const forgeConfig = fs.readFileSync(path.join(root, 'forge.config.cjs'), 'utf8');
    const builtinRuntime = fs.readFileSync(
        path.join(root, 'dist', 'plugins', 'opendesk-wps-slides', 'index.mjs'),
        'utf8'
    );
    assert.match(forgeConfig, /\[FuseV1Options\.RunAsNode\]: true/);
    assert.match(builtinRuntime, /command: nodeExecutable/);
    assert.match(builtinRuntime, /useElectronNode \? process\.execPath : resolveNodeExecutable\(\)/);
    assert.match(builtinRuntime, /if \(!useElectronNode\) verifyNodeExecutable\(nodeExecutable\)/);
    assert.match(builtinRuntime, /useElectronNode \? \{ ELECTRON_RUN_AS_NODE: '1' \} : \{\}/);
    assert.match(builtinRuntime, /OPENDESK_WPS_MCP_COMMAND: nodeExecutable/);
});

test('ships the host SDK with the CLI without a registry SDK dependency', () => {
    const script = fs.readFileSync(path.join(root, 'scripts', 'packaging', 'createCliRelease.sh'), 'utf8');
    const template = script.match(/cat > "\$RELEASE_DIR\/package\.json" << EOF\r?\n([\s\S]*?)\r?\nEOF/)[1];
    for (const version of ['1.2.3', '1.2.3-nightly-20260908']) {
        const manifest = JSON.parse(template.replaceAll('${VERSION}', version));
        assert.equal(Object.hasOwn(manifest.dependencies, '@bitclub.ai/opendesk-plugin-sdk'), false);
        const sdkManifest = JSON.parse(fs.readFileSync(path.join(root, 'packages/plugin-sdk/package.json'), 'utf8'));
        assert.equal(manifest.dependencies.zod, sdkManifest.dependencies.zod);
    }
    assert.match(script, /SDK_TARGET="\$RELEASE_DIR\/dist\/node_modules\/@bitclub\.ai\/opendesk-plugin-sdk"/);
    assert.match(script, /cp -R packages\/plugin-sdk\/dist "\$SDK_TARGET\/dist"/);
    assert.match(script, /cp packages\/plugin-sdk\/package\.json "\$SDK_TARGET\/package\.json"/);
    assert.equal(script.split('cp -R dist/plugins "$RELEASE_DIR/dist/plugins"').length - 1, 1);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

test('Windows sandbox sources and build entrypoint are included', () => {
    const project = path.join(root, 'native', 'windows', 'sandbox', 'src', 'Dynobox', 'Dynobox.csproj');
    const buildScript = path.join(root, 'scripts', 'build-windows-sandbox.cjs');
    const policy = path.join(root, 'native', 'windows', 'sandbox', 'src', 'Dynobox', 'Policy.cs');
    const runtime = fs.readFileSync(
        path.join(root, 'src', 'main', 'applications', 'terminal', 'sandboxes', 'dynabox.ts'),
        'utf8'
    );
    const forgeConfig = fs.readFileSync(path.join(root, 'forge.config.cjs'), 'utf8');
    const bundle = fs.readFileSync(path.join(root, 'resources', 'package', 'bootstrapper', 'bundle.wxs'), 'utf8');
    const bootstrapperBuild = fs.readFileSync(path.join(root, 'scripts', 'build-wix-bootstrapper.mjs'), 'utf8');

    assert.equal(fs.existsSync(project), true);
    assert.equal(fs.existsSync(buildScript), true);
    assert.match(fs.readFileSync(buildScript, 'utf8'), /PublishSingleFile=true/);
    assert.match(fs.readFileSync(buildScript, 'utf8'), /runtimeDirectory[\s\S]*sandbox\.exe/);
    assert.match(forgeConfig, /resourcesRoot, 'sandbox'/);
    assert.match(
        bundle,
        /<MsiPackage Id="DokanMsi"[\s\S]*?SourceFile="\$\(var\.DokanMsiPath\)"[\s\S]*?InstallCondition="NOT DokanVersion/
    );
    assert.match(bootstrapperBuild, /DokanSetup\.msi/);
    assert.match(runtime, /resourcesPath \|\| ''[\s\S]*?sandbox', 'sandbox\.exe'/);
    assert.match(runtime, /native', 'windows', 'sandbox', 'runtime', 'sandbox\.exe'/);
    assert.match(fs.readFileSync(policy, 'utf8'), /AuthenticationHeaderValue\("Bearer"/);
});

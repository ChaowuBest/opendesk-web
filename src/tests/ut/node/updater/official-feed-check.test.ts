import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '../../../../..');

test('declares a production feed smoke test that downloads without installing', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    const scriptPath = path.join(projectRoot, 'scripts', 'check-windows-update-feed.ts');

    assert.equal(packageJson.scripts['check:windows-update-feed'], 'tsx scripts/check-windows-update-feed.ts');
    assert.equal(fs.existsSync(scriptPath), true);

    const source = fs.readFileSync(scriptPath, 'utf8');
    assert.match(source, /DEFAULT_UPDATE_FEED_URL/);
    assert.match(source, /fetchLatestRelease/);
    assert.match(source, /downloadInstaller/);
    assert.doesNotMatch(source, /submitUpdate|update-service-client|OpenDesk\.UpdateService/);
});

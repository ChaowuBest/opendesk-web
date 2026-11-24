import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('uses the declared exact ACP SDK version', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const installed = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'node_modules/@agentclientprotocol/sdk/package.json'), 'utf8')
    );
    assert.equal(manifest.dependencies['@agentclientprotocol/sdk'], '1.3.0');
    assert.equal(installed.version, manifest.dependencies['@agentclientprotocol/sdk']);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compareBlockMaps, parseBlockMapXml } from '../../../../../scripts/phase0-windows-update/lib/msix-blockmap.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '../../../../..');

const baselineXml = `<?xml version="1.0" encoding="UTF-8"?>
<BlockMap xmlns="http://schemas.microsoft.com/appx/2010/blockmap" HashMethod="http://www.w3.org/2001/04/xmlenc#sha256">
    <File Name="app\\resources\\app.asar" Size="100000" LfhSize="72">
        <Block Hash="same-first-block" Size="50000" />
        <Block Hash="old-second-block" Size="25000" />
    </File>
    <File Name="app\\resources\\native.dll" Size="100" LfhSize="70">
        <Block Hash="same-native-block" Size="80" />
    </File>
</BlockMap>`;

const candidateXml = `<?xml version="1.0" encoding="UTF-8"?>
<BlockMap xmlns="http://schemas.microsoft.com/appx/2010/blockmap" HashMethod="http://www.w3.org/2001/04/xmlenc#sha256">
    <File Name="app\\resources\\app.asar" Size="100000" LfhSize="72">
        <Block Hash="same-first-block" Size="50000" />
        <Block Hash="new-second-block" Size="26000" />
    </File>
    <File Name="app\\resources\\native.dll" Size="100" LfhSize="70">
        <Block Hash="same-native-block" Size="80" />
    </File>
    <File Name="app\\resources\\new.txt" Size="10" LfhSize="65">
        <Block Hash="new-file-block" Size="10" />
    </File>
</BlockMap>`;

test('compares MSIX block maps using the Windows 64 KiB block boundary', async () => {
    const baseline = await parseBlockMapXml(baselineXml);
    const candidate = await parseBlockMapXml(candidateXml);
    const comparison = compareBlockMaps(baseline, candidate);

    assert.equal(comparison.candidateFileCount, 3);
    assert.equal(comparison.candidateBlockCount, 4);
    assert.equal(comparison.reusedBlockCount, 2);
    assert.equal(comparison.changedBlockCount, 2);
    assert.equal(comparison.candidatePayloadBytes, 100110);
    assert.equal(comparison.reusedPayloadBytes, 65636);
    assert.equal(comparison.changedPayloadBytes, 34474);
    assert.equal(comparison.estimatedPayloadReusePercent, 65.56);
    assert.equal(comparison.candidateCompressedBlockBytes, 76090);
    assert.equal(comparison.reusedCompressedBlockBytes, 50080);
});

test('declares repeatable Phase 0 Windows update commands', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

    assert.equal(
        packageJson.scripts['phase0:update:wix-inspect'],
        'node scripts/phase0-windows-update/wix-inspect.mjs'
    );
    assert.equal(
        packageJson.scripts['phase0:update:msix-package'],
        'node scripts/phase0-windows-update/msix-package.mjs'
    );
    assert.equal(
        packageJson.scripts['phase0:update:msix-compare'],
        'node scripts/phase0-windows-update/msix-compare.mjs'
    );
});

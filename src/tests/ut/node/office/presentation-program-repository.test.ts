import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PresentationProgramRepository } from '../../../../main/applications/slides/programRepository.js';

test('presentation repository persists stage evidence and a distinct timeout status', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'presentation-program-repository-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repository = new PresentationProgramRepository(root);

    const recorded = await repository.recordRun(
        {
            taskId: 'task-timeout',
            outputPath: path.join(root, 'deck.pptx'),
            program: 'return deck.inspect();',
            sourcePath: path.join(root, 'main.mjs'),
            startFrom: 'blank'
        },
        async (context) => {
            context.reportStage('rendering-slides');
            return {
                apiVersion: 'presentation/v1',
                ok: false,
                error: {
                    code: 'PRESENTATION_PROGRAM_TIMEOUT',
                    message: 'timed out'
                }
            };
        }
    );

    assert.equal(recorded.result.ok, false);
    const projectDirectory = path.join(root, 'projects', fs.readdirSync(path.join(root, 'projects'))[0]!);
    const run = JSON.parse(fs.readFileSync(path.join(projectDirectory, 'runs', 'program-000001.json'), 'utf8')) as {
        status: string;
        stage: string;
        stageUpdatedAt?: string;
    };
    assert.equal(run.status, 'timed_out');
    assert.equal(run.stage, 'rendering-slides');
    assert.ok(run.stageUpdatedAt);
});

test('generator retries recover archived assets after a failed run and process restart', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'presentation-assets-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, 'main.mjs');
    const repository = new PresentationProgramRepository(root);
    await repository.recordRun(
        {
            taskId: 'asset-task',
            outputPath: path.join(root, 'deck.pptx'),
            sourcePath,
            program: 'bad generator',
            startFrom: 'blank',
            expectedSlideCount: 5,
            assets: { hero: { sourcePath: '/original/removed.png', bytes: new Uint8Array([1, 2, 3]), ext: 'png' } }
        },
        async () => ({ apiVersion: 'presentation/v1', ok: false })
    );
    const restarted = new PresentationProgramRepository(root);
    const assets = restarted.getAssetPaths('asset-task', sourcePath);
    assert.deepEqual([...fs.readFileSync(assets.hero!)], [1, 2, 3]);
    assert.deepEqual(restarted.getAssetPaths('other-task', sourcePath), {});
    assert.deepEqual(restarted.getAssetPaths('asset-task', path.join(root, 'other.mjs')), {});
    assert.equal(restarted.getExpectedSlideCount('asset-task', sourcePath), 5);
    await restarted.recordRun(
        {
            taskId: 'asset-task',
            outputPath: path.join(root, 'deck.pptx'),
            sourcePath,
            program: 'retry generator',
            startFrom: 'blank'
        },
        async () => ({ apiVersion: 'presentation/v1', ok: true })
    );
    assert.deepEqual(restarted.getAssetPaths('asset-task', sourcePath), assets);
    const manifestPath = path.join(root, 'projects', fs.readdirSync(path.join(root, 'projects'))[0]!, 'manifest.json');
    const legacyManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete legacyManifest.assets;
    fs.writeFileSync(manifestPath, JSON.stringify(legacyManifest));
    assert.deepEqual(new PresentationProgramRepository(root).getAssetPaths('asset-task', sourcePath), assets);
});

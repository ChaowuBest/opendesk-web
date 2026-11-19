import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
    runPresentationProgram,
    presentationRevisionFromBytes
} from '@bitclub.ai/opendesk-office/presentation-automation';
import { PresentationProgramRepository } from '../../../../main/applications/slides/programRepository.js';
import {
    PresentationProgramService,
    type PresentationProgramHost
} from '../../../../main/office/presentationProgramService.js';

function fixture(t: { after(callback: () => void): void }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'presentation-host-port-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repository = new PresentationProgramRepository(path.join(root, 'history'));
    return { root, repository };
}

test('an external host uses the shared generator repository, assets and headless commit', async (t) => {
    const { root, repository } = fixture(t);
    const asset = path.join(root, 'image.png');
    fs.writeFileSync(asset, Buffer.from('host-owned image'));
    const outputs: string[] = [];
    const host: PresentationProgramHost<object> = {
        runHeadlessPresentationProgram: runPresentationProgram,
        runPresentationProgram: async () => {
            throw new Error('unexpected live route');
        },
        getPresentationSnapshot: async () => {
            throw new Error('unexpected live snapshot');
        }
    };
    const service = new PresentationProgramService({
        getRepository: () => repository,
        getSession: () => undefined,
        loadHost: async () => host,
        openPresentation: async (_task, filePath) => {
            outputs.push(filePath);
            return { status: 'not_opened', filePath };
        },
        translate: (key) => key,
        log: () => {}
    });
    assert.equal(await service.isAvailable(), true);
    const result = await service.execute('external-task', {
        program: "deck.slide(0).setNotes('external host'); return deck.slides()",
        startFrom: 'blank',
        workspace: root,
        assets: { cover: asset }
    });
    assert.equal(result.ok, true);
    assert.equal(result.committed, true);
    assert.ok(fs.existsSync(result.outputPath));
    assert.ok(fs.existsSync(result.provenance.sourcePath));
    assert.deepEqual(outputs, [result.outputPath]);
    assert.equal(result.open?.status, 'not_opened');
    const archived = repository.getAssetPaths('external-task', result.provenance.sourcePath);
    assert.equal(fs.readFileSync(archived.cover, 'utf8'), 'host-owned image');
    fs.writeFileSync(result.provenance.sourcePath, "deck.slide(0).setNotes('rerun'); return deck.slides()");
    const retry = await service.execute('external-task', {
        programPath: result.provenance.sourcePath,
        startFrom: 'blank',
        workspace: root
    });
    assert.equal(retry.ok, true);
    assert.equal(retry.outputPath, result.outputPath);
    assert.equal(retry.provenance.priorRunCount, 1);
});

test('a live external editor receives revision and unsaved-change decisions without an extra file commit', async (t) => {
    const { root, repository } = fixture(t);
    const filePath = path.join(root, 'live.pptx');
    const seed = await runPresentationProgram({ program: "deck.slide(0).setNotes('seed')", startFrom: 'blank' });
    assert.equal(seed.ok, true);
    const bytes = seed.bytes!;
    fs.writeFileSync(filePath, bytes);
    const revision = await presentationRevisionFromBytes(bytes);
    const editor = { id: 'host-editor' };
    let liveCalls = 0;
    const service = new PresentationProgramService({
        getRepository: () => repository,
        getSession: () => ({ filePath, contents: editor }),
        loadHost: async () => ({
            getPresentationSnapshot: async (contents) => {
                assert.equal(contents, editor);
                return { bytes, revision, path: filePath };
            },
            runPresentationProgram: async (contents, request, control) => {
                liveCalls++;
                assert.equal(contents, editor);
                assert.equal(request.expectedRevision, revision);
                assert.equal(request.unsavedChanges, 'save');
                assert.equal(request.outputPath, filePath);
                assert.equal(control?.signal?.aborted, false);
                return { apiVersion: 'presentation/v1', ok: false, error: { code: 'UNSAVED_CHANGES' } };
            },
            runHeadlessPresentationProgram: async () => {
                throw new Error('unexpected headless route');
            }
        }),
        openPresentation: async () => {
            throw new Error('unexpected reopen');
        },
        log: () => {}
    });
    const result = await service.execute('live-task', {
        program: 'return deck.slides()',
        startFrom: 'auto',
        unsavedChanges: 'save',
        workspace: root
    });
    assert.equal(liveCalls, 1);
    assert.equal(result.ok, false);
    assert.equal(result.committed, false);
    assert.deepEqual(fs.readFileSync(filePath), Buffer.from(bytes));
    assert.ok(fs.existsSync(result.provenance.sourcePath));
});

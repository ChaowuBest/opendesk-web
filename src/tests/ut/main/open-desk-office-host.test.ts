import { afterAll, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface MatcherOptions {
    rendererFilePath: string;
    rendererDevUrl?: string;
}

const nativeAutomation = await import('@bitclub.ai/opendesk-office/presentation-automation');
const programRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'office-host-retry-'));
afterAll(() => fs.rmSync(programRoot, { recursive: true, force: true }));

const matcherOptions: MatcherOptions[] = [];
const ipcHandlers = new Map<string, (...args: any[]) => unknown>();
const officeSession = {};
const browserSession = {};
let webContentsById: unknown;

jest.unstable_mockModule('@bitclub.ai/opendesk-office/host-security', () => ({
    createTrustedRendererUrlMatcher: (options: MatcherOptions) => {
        matcherOptions.push(options);
        return (url: string) => {
            const documentUrl = url.split(/[?#]/, 1)[0];
            const rendererPage = options.rendererFilePath.replace(/^.*[/\\]/, '');
            return (
                url === '' ||
                documentUrl === `./${rendererPage}` ||
                documentUrl === pathToFileURL(options.rendererFilePath).href ||
                (options.rendererDevUrl !== undefined && documentUrl === options.rendererDevUrl)
            );
        };
    }
}));

jest.unstable_mockModule('@bitclub.ai/opendesk-office/presentation-automation', () => nativeAutomation, {
    virtual: true
});

jest.unstable_mockModule('electron', () => ({
    app: {
        getPath: jest.fn(() => programRoot)
    },
    ipcMain: {
        handle: jest.fn((channel: string, handler: (...args: any[]) => unknown) => {
            ipcHandlers.set(channel, handler);
        }),
        on: jest.fn()
    },
    session: {
        fromPartition: jest.fn((partition: string) =>
            partition === 'persist:opendesk-office' ? officeSession : browserSession
        )
    },
    webContents: {
        fromId: jest.fn(() => webContentsById)
    }
}));

const officeHost = {
    getPresentationSnapshot: jest.fn(),
    register: jest.fn(),
    attachWindow: jest.fn(),
    activateContents: jest.fn(),
    requestCloseAll: jest.fn(async () => true),
    runHeadlessPresentationProgram: jest.fn(nativeAutomation.runPresentationProgram),
    runPresentationProgram: jest.fn()
};

jest.unstable_mockModule('@bitclub.ai/opendesk-office/main', () => ({
    createOpenDeskOfficeSlidesHost: jest.fn(async () => officeHost)
}));

jest.unstable_mockModule('@bitclub.ai/opendesk-office/word-main', () => ({
    createOpenDeskOfficeWordHost: jest.fn(async () => officeHost)
}));

jest.unstable_mockModule('@bitclub.ai/opendesk-office/sheets-main', () => ({
    createOpenDeskOfficeSheetsHost: jest.fn(async () => officeHost)
}));

jest.unstable_mockModule('../../../locale/index.js', () => ({
    t: (key: string) => key
}));

jest.unstable_mockModule('../../../main/utils/electron-ipc.js', () => ({
    safeSendToWebContents: jest.fn()
}));

Object.defineProperty(globalThis, '__dirname', {
    value: fileURLToPath(new URL('../../../main/', import.meta.url)),
    configurable: true
});

const {
    getEmbeddedOpenDeskOfficeEditorKind,
    getOpenDeskOfficeEditorKind,
    registerEmbeddedOpenDeskOffice,
    runOpenDeskPresentationProgram
} = await import('../../../main/office/openDeskOfficeHost.js');
Reflect.deleteProperty(globalThis, '__dirname');

describe('OpenDesk Office webview ownership', () => {
    it('does not classify unattached or ordinary browser content as an Office editor', () => {
        expect(getOpenDeskOfficeEditorKind('')).toBeUndefined();
        expect(getOpenDeskOfficeEditorKind('   ')).toBeUndefined();
        expect(getOpenDeskOfficeEditorKind('https://example.com/login')).toBeUndefined();

        expect(getOpenDeskOfficeEditorKind(pathToFileURL(matcherOptions[0].rendererFilePath).href)).toBe('slides');
    });

    it('requires the Office partition before assigning Office ownership', () => {
        const slidesUrl = pathToFileURL(matcherOptions[0].rendererFilePath).href;

        expect(getEmbeddedOpenDeskOfficeEditorKind(slidesUrl, undefined)).toBeUndefined();
        expect(getEmbeddedOpenDeskOfficeEditorKind(slidesUrl, 'persist:opendesk-browser')).toBeUndefined();
        expect(getEmbeddedOpenDeskOfficeEditorKind(slidesUrl, 'persist:opendesk-office')).toBe('slides');
        expect(
            getEmbeddedOpenDeskOfficeEditorKind(
                './slides_editor.html?mode=tab&file=%2Ftmp%2Fdeck.pptx',
                'persist:opendesk-office'
            )
        ).toBe('slides');
    });

    it('rejects Office task binding from a non-Office session even when the URL is trusted', async () => {
        registerEmbeddedOpenDeskOffice();
        const bindTask = ipcHandlers.get('office-host:bind-task');
        const slidesUrl = pathToFileURL(matcherOptions[0].rendererFilePath).href;
        webContentsById = {
            id: 42,
            session: browserSession,
            hostWebContents: { id: 7 },
            isDestroyed: () => false,
            getType: () => 'webview',
            getURL: () => slidesUrl
        };

        await expect(bindTask?.({ sender: { id: 7 } }, 'slides', 'task-a', '/tmp/deck.pptx', 42)).resolves.toBe(false);
        expect(officeHost.activateContents).not.toHaveBeenCalled();
    });

    it('allows a trusted Office webview in the dedicated Office session to bind', async () => {
        registerEmbeddedOpenDeskOffice();
        const bindTask = ipcHandlers.get('office-host:bind-task');
        const slidesUrl = pathToFileURL(matcherOptions[0].rendererFilePath).href;
        webContentsById = {
            id: 43,
            session: officeSession,
            hostWebContents: { id: 7 },
            isDestroyed: () => false,
            getType: () => 'webview',
            getURL: () => slidesUrl,
            once: jest.fn()
        };

        await expect(bindTask?.({ sender: { id: 7 } }, 'slides', 'task-b', '/tmp/deck.pptx', 43)).resolves.toBe(true);
        expect(officeHost.activateContents).toHaveBeenCalledWith(webContentsById);
    });
});

describe('presentation generator recovery and revision protection', () => {
    it('recovers archived assets and preserves changes made after generation', async () => {
        const imagePath = path.join(programRoot, 'hero.png');
        const image = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA9sAAAAASUVORK5CYII=',
            'base64'
        );
        fs.writeFileSync(imagePath, image);
        const failed = await runOpenDeskPresentationProgram('recover-assets', {
            program: "throw new Error('fix generator');",
            startFrom: 'blank',
            outputPath: path.join(programRoot, 'deck.pptx'),
            assets: { hero: imagePath },
            workspace: programRoot
        });
        expect(failed.ok).toBe(false);
        fs.unlinkSync(imagePath);
        fs.writeFileSync(
            failed.provenance.sourcePath,
            "deck.slide(0).add({kind:'image',asset:'hero',box:{x:20,y:20,w:40,h:40}});"
        );
        const retry = await runOpenDeskPresentationProgram('recover-assets', {
            programPath: failed.provenance.sourcePath,
            startFrom: 'blank',
            outputPath: path.join(programRoot, 'deck.pptx'),
            workspace: programRoot
        });
        expect(retry.ok).toBe(true);
        expect(retry.committed).toBe(true);
        expect(Buffer.from(officeHost.runHeadlessPresentationProgram.mock.calls.at(-1)![0].assets!.hero.bytes)).toEqual(
            image
        );
        // Explicit replacement wins over the archived asset even after the original was deleted.
        const replacementPath = path.join(programRoot, 'replacement.png');
        fs.writeFileSync(replacementPath, image);
        const replaced = await runOpenDeskPresentationProgram('recover-assets', {
            programPath: failed.provenance.sourcePath,
            startFrom: 'blank',
            outputPath: path.join(programRoot, 'deck.pptx'),
            assets: { hero: replacementPath },
            workspace: programRoot
        });
        expect(replaced.ok).toBe(true);

        const outputPath = path.join(programRoot, 'deck.pptx');
        const generatedRevision = replaced.revision as { after: string };
        const manual = await nativeAutomation.runPresentationProgram({
            startFrom: 'current',
            currentBytes: new Uint8Array(fs.readFileSync(outputPath)),
            program: "deck.slide(0).add({kind:'text',text:'User edit',box:{x:100,y:100,w:300,h:50}});"
        });
        expect(manual.ok).toBe(true);
        fs.writeFileSync(outputPath, manual.bytes!);
        const currentRevision = await nativeAutomation.presentationRevisionFromBytes(manual.bytes!);
        const rerun = {
            programPath: replaced.provenance.sourcePath,
            startFrom: 'blank' as const,
            outputPath,
            workspace: programRoot
        };
        const callsBefore = officeHost.runHeadlessPresentationProgram.mock.calls.length;
        const blocked = await runOpenDeskPresentationProgram('recover-assets', rerun);
        expect(blocked.ok).toBe(false);
        expect(blocked.committed).toBe(false);
        expect(blocked.error).toMatchObject({
            code: 'GENERATOR_OUTPUT_CHANGED',
            details: { lastGeneratedRevision: generatedRevision.after, currentRevision }
        });
        expect(blocked.recovery).toBeUndefined();
        expect(officeHost.runHeadlessPresentationProgram.mock.calls.length).toBe(callsBefore);
        expect(fs.readFileSync(outputPath)).toEqual(Buffer.from(manual.bytes!));
        const revisionOnly = await runOpenDeskPresentationProgram('recover-assets', {
            ...rerun,
            expectedRevision: currentRevision
        });
        expect(revisionOnly.ok).toBe(false);
        const incremental = await runOpenDeskPresentationProgram('recover-assets', {
            program: "deck.slide(0).add({kind:'text',text:'Requested change',box:{x:100,y:200,w:300,h:50}});",
            startFrom: 'current',
            expectedRevision: currentRevision,
            outputPath,
            workspace: programRoot
        });
        expect(incremental.ok).toBe(true);
        const inspection = await nativeAutomation.runPresentationProgram({
            startFrom: 'current',
            currentBytes: new Uint8Array(fs.readFileSync(outputPath)),
            program: "return deck.inspect({ level: 'elements' });"
        });
        expect(inspection.ok).toBe(true);
        const deck = inspection.value as { slides: Array<{ elements: Array<{ text?: string }> }> };
        expect(deck.slides[0].elements.map((element) => element.text)).toEqual(
            expect.arrayContaining(['User edit', 'Requested change'])
        );
        webContentsById = {
            id: 48,
            once: jest.fn(),
            session: officeSession,
            hostWebContents: { id: 7 },
            isDestroyed: () => false,
            getType: () => 'webview',
            getURL: () => pathToFileURL(matcherOptions[0].rendererFilePath).href
        };
        await ipcHandlers.get('office-host:bind-task')?.(
            { sender: { id: 7 } },
            'slides',
            'recover-assets',
            outputPath,
            48
        );
        officeHost.getPresentationSnapshot.mockResolvedValueOnce({
            bytes: manual.bytes,
            revision: currentRevision,
            path: outputPath
        } as never);
        const liveCalls = officeHost.runPresentationProgram.mock.calls.length;
        const liveBlocked = await runOpenDeskPresentationProgram('recover-assets', rerun);
        expect(liveBlocked.error).toMatchObject({ code: 'GENERATOR_OUTPUT_CHANGED' });
        expect(officeHost.runPresentationProgram.mock.calls.length).toBe(liveCalls);
    }, 30_000);

    it('returns live editor results without a second snapshot read', async () => {
        const generated = await nativeAutomation.runPresentationProgram({
            startFrom: 'blank',
            program: 'return deck.inspect();'
        });
        expect(generated.ok).toBe(true);
        officeHost.getPresentationSnapshot.mockResolvedValue({
            bytes: generated.bytes,
            revision: 'presentation/v1:live',
            path: '/tmp/deck.pptx'
        } as never);
        officeHost.runPresentationProgram.mockResolvedValue({
            apiVersion: 'presentation/v1',
            ok: true,
            diff: { slideChanges: [{}] },
            validation: { summary: { qualityPassed: true } }
        } as never);
        const readsBefore = officeHost.getPresentationSnapshot.mock.calls.length;
        const result = await runOpenDeskPresentationProgram('task-b', {
            program: 'return deck.inspect();',
            startFrom: 'current',
            workspace: programRoot
        });
        expect(result.ok).toBe(true);
        expect(result.committed).toBe(true);
        expect(result.validation).toEqual({ summary: { qualityPassed: true } });
        expect(officeHost.getPresentationSnapshot.mock.calls.length).toBe(readsBefore + 1);
    }, 30_000);
});

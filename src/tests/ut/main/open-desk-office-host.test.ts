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

describe('presentation generator recovery and acceptance', () => {
    it('retries failed generators from archived images and separates content acceptance from execution success', async () => {
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
            expectedSlideCount: 5,
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
        expect(retry.contentReview?.expectedSlideCount).toBe(5);
        expect(retry.acceptance?.structuralPassed).toBe(true);
        expect(retry.acceptance?.contentPassed).toBe(false);
        expect(retry.acceptance?.passed).toBe(false);
        expect(retry.contentReview?.findings).toContainEqual({ code: 'SLIDE_COUNT_MISMATCH' });
        expect(Buffer.from(officeHost.runHeadlessPresentationProgram.mock.calls.at(-1)![0].assets!.hero.bytes)).toEqual(
            image
        );
        // Explicit replacement wins over the archived asset even after the original was deleted.
        const replacementPath = path.join(programRoot, 'replacement.png');
        fs.writeFileSync(replacementPath, image);
        const replaced = await runOpenDeskPresentationProgram('recover-assets', {
            programPath: failed.provenance.sourcePath,
            startFrom: 'blank',
            expectedSlideCount: 1,
            outputPath: path.join(programRoot, 'deck.pptx'),
            assets: { hero: replacementPath },
            workspace: programRoot
        });
        expect(replaced.ok).toBe(true);
        expect(replaced.contentReview?.passed).toBe(true);
        expect(replaced.acceptance?.passed).toBe(true);
    }, 30_000);

    it('reviews live editor snapshots when the live result does not include bytes', async () => {
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
        const result = await runOpenDeskPresentationProgram('task-b', {
            program: 'return deck.inspect();',
            startFrom: 'current',
            expectedSlideCount: 2,
            workspace: programRoot
        });
        expect(result.ok).toBe(true);
        expect(result.committed).toBe(true);
        expect(result.acceptance).toEqual({ passed: false, structuralPassed: true, contentPassed: false });
        officeHost.getPresentationSnapshot
            .mockResolvedValueOnce({
                bytes: generated.bytes,
                revision: 'presentation/v1:live',
                path: '/tmp/deck.pptx'
            } as never)
            .mockRejectedValueOnce(new Error('snapshot failed') as never);
        const unavailable = await runOpenDeskPresentationProgram('task-b', {
            program: 'return deck.inspect();',
            startFrom: 'current',
            workspace: programRoot
        });
        expect(unavailable.ok).toBe(true);
        expect(unavailable.committed).toBe(true);
        expect(unavailable.contentReview?.complete).toBe(false);
        expect(unavailable.acceptance?.passed).toBe(false);
    }, 30_000);
});

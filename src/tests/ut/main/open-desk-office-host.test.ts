import { describe, expect, it, jest } from '@jest/globals';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface MatcherOptions {
    rendererFilePath: string;
    rendererDevUrl?: string;
}

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

jest.unstable_mockModule('electron', () => ({
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
    register: jest.fn(),
    attachWindow: jest.fn(),
    activateContents: jest.fn(),
    requestCloseAll: jest.fn(async () => true)
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

const { getEmbeddedOpenDeskOfficeEditorKind, getOpenDeskOfficeEditorKind, registerEmbeddedOpenDeskOffice } =
    await import('../../../main/office/openDeskOfficeHost.js');
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

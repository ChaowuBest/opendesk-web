import { describe, expect, it, jest } from '@jest/globals';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface MatcherOptions {
    rendererFilePath: string;
    rendererDevUrl?: string;
}

const matcherOptions: MatcherOptions[] = [];

jest.unstable_mockModule('@bitclub.ai/opendesk-office/host-security', () => ({
    createTrustedRendererUrlMatcher: (options: MatcherOptions) => {
        matcherOptions.push(options);
        return (url: string) =>
            url === '' ||
            url === pathToFileURL(options.rendererFilePath).href ||
            (options.rendererDevUrl !== undefined && url === options.rendererDevUrl);
    }
}));

jest.unstable_mockModule('electron', () => ({
    ipcMain: {
        handle: jest.fn(),
        on: jest.fn()
    }
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

const { getOpenDeskOfficeEditorKind } = await import('../../../main/office/openDeskOfficeHost.js');
Reflect.deleteProperty(globalThis, '__dirname');

describe('OpenDesk Office editor URL matching', () => {
    it('does not classify unattached or ordinary browser content as an Office editor', () => {
        expect(getOpenDeskOfficeEditorKind('')).toBeUndefined();
        expect(getOpenDeskOfficeEditorKind('   ')).toBeUndefined();
        expect(getOpenDeskOfficeEditorKind('https://example.com/login')).toBeUndefined();

        expect(getOpenDeskOfficeEditorKind(pathToFileURL(matcherOptions[0].rendererFilePath).href)).toBe('slides');
    });
});

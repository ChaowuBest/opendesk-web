import { expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'node:events';

const fromId = jest.fn();
const safeSendToWebContents = jest.fn();

jest.unstable_mockModule('electron', () => ({ dialog: {}, webContents: { fromId } }));
jest.unstable_mockModule('../../../main/applications/registry.js', () => ({
    ApplicationRegistry: { getApplication: () => undefined }
}));
jest.unstable_mockModule('../../../main/utils/logger.js', () => ({ logger: { debug: jest.fn() } }));
jest.unstable_mockModule('../../../main/utils/electron-ipc.js', () => ({ safeSendToWebContents }));
jest.unstable_mockModule('../../../locale/index.js', () => ({ translateWithDomain: (key: string) => key }));

const { installBrowserCertificates } = await import('../../../main/applications/browser/certificateElectron.js');

test('only the main frame can approve a pending certificate error in its own browser tab', () => {
    type Approve = (event: unknown, id: number, url: string) => boolean;
    const handlers = new Map<string, Approve>();
    const shell = Object.assign(new EventEmitter(), {
        mainFrame: {},
        ipc: { handle: (channel: string, handler: Approve) => handlers.set(channel, handler) }
    });
    const navigation = jest.fn(async (_url: string) => {});
    const guest = Object.assign(new EventEmitter(), {
        id: 17,
        getType: () => 'webview',
        hostWebContents: shell,
        loadURL: navigation
    });
    const url = 'https://127.0.0.1:8443/';
    const finish = jest.fn();
    const reportError = () =>
        guest.emit(
            'certificate-error',
            { preventDefault: jest.fn() },
            url,
            'net::ERR_CERT_AUTHORITY_INVALID',
            { fingerprint: 'cert-A' },
            finish,
            true
        );

    installBrowserCertificates(
        { webContents: shell } as unknown as Electron.BrowserWindow,
        (target) => target.id === 17
    );
    shell.emit('did-attach-webview', {}, guest);
    fromId.mockReturnValue(guest);
    reportError();
    expect(finish).not.toHaveBeenCalled();

    const approve = handlers.get('browser:continueCertificate')!;
    const event = { sender: shell, senderFrame: shell.mainFrame };
    expect(approve({ ...event, senderFrame: {} }, 17, url)).toBe(false);
    guest.hostWebContents = Object.assign(new EventEmitter(), shell);
    expect(approve(event, 17, url)).toBe(false);
    expect(navigation).not.toHaveBeenCalled();

    guest.hostWebContents = shell;
    expect(approve(event, 17, url)).toBe(true);
    expect(navigation).toHaveBeenCalledWith(url);
    reportError();
    expect(finish).toHaveBeenCalledWith(true);
    expect(safeSendToWebContents).toHaveBeenCalledWith(shell, 'browser:certificateExceptionApplied', 17, url);
});

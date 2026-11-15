import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';

const partition = {};
const confirmSave = jest.fn<any>();
const showMessageBox = jest.fn<any>();
jest.unstable_mockModule('electron', () => ({
    app: {},
    safeStorage: {},
    session: { fromPartition: () => partition },
    dialog: { showMessageBox }
}));
jest.unstable_mockModule('../../../main/services/browser-credentials/save-prompt.js', () => ({
    showCredentialSavePrompt: confirmSave
}));
jest.unstable_mockModule('../../../locale/index.js', () => ({
    t: (key: string) => key,
    translateWithDomain: (key: string) => key
}));
const { installBrowserCredentials } = await import('../../../main/services/browser-credentials/manager.js');

describe('credential IPC boundaries', () => {
    let contents: any;
    let handlers: Record<string, any>;
    let vault: any;
    let event: any;
    beforeEach(() => {
        confirmSave.mockReset();
        confirmSave.mockResolvedValue(true);
        showMessageBox.mockReset();
        showMessageBox.mockResolvedValue({ response: 1 });
        handlers = {};
        contents = Object.assign(new EventEmitter(), {
            session: partition,
            mainFrame: { url: 'https://example.com/login' },
            isDestroyed: () => false,
            isFocused: () => true,
            ipc: {
                handle: (channel: string, handler: any) => {
                    handlers[channel] = handler;
                }
            }
        });
        event = { sender: contents, senderFrame: contents.mainFrame };
        vault = {
            revision: 0,
            available: () => true,
            list: () => ['alice', 'bob'],
            get: jest.fn<any>().mockReturnValue('secret'),
            save: jest.fn()
        };
        const listeners = new Set<() => void>();
        vault.onClear = (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        };
        vault.clear = () => {
            vault.revision += 1;
            for (const listener of listeners) listener();
        };
        installBrowserCredentials({ isDestroyed: () => false } as any, contents, vault);
    });
    it('lists usernames without reading passwords and releases only an explicitly selected account', async () => {
        const list = await handlers['browser-credentials:list'](event);
        expect(list.usernames).toEqual(['alice', 'bob']);
        expect(vault.get).not.toHaveBeenCalled();
        expect(
            await handlers['browser-credentials:fill'](event, { requestId: list.requestId, username: 'bob' })
        ).toEqual({ username: 'bob', password: 'secret' });
        expect(
            await handlers['browser-credentials:fill'](event, { requestId: list.requestId, username: 'bob' })
        ).toBeNull();
    });
    it('rejects foreign senders, subframes, non-browser partitions and insecure origins', async () => {
        const handler = handlers['browser-credentials:list'];
        expect(await handler({ ...event, sender: {} })).toBeNull();
        expect(await handler({ ...event, senderFrame: { url: 'https://example.com/login' } })).toBeNull();
        contents.session = {};
        expect(await handler(event)).toBeNull();
        contents.session = partition;
        contents.mainFrame.url = 'http://example.com';
        expect(await handler(event)).toBeNull();
        expect(vault.get).not.toHaveBeenCalled();
    });
    it('invalidates a menu on navigation, even back to the same origin', async () => {
        const list = await handlers['browser-credentials:list'](event);
        contents.emit('did-start-navigation', {}, 'https://example.com/other', false, true);
        expect(
            await handlers['browser-credentials:fill'](event, { requestId: list.requestId, username: 'alice' })
        ).toBeNull();
        expect(vault.get).not.toHaveBeenCalled();
    });
    it('invalidates a menu when saved data has been cleared', async () => {
        const list = await handlers['browser-credentials:list'](event);
        vault.revision += 1;
        expect(
            await handlers['browser-credentials:fill'](event, { requestId: list.requestId, username: 'alice' })
        ).toBeNull();
    });
    it('saves a new account only after explicit confirmation', async () => {
        vault.get.mockReturnValue(undefined);
        confirmSave.mockResolvedValue(false);
        await handlers['browser-credentials:save'](event, { username: 'new-account', password: 'new-secret' });
        expect(vault.save).not.toHaveBeenCalled();
        confirmSave.mockResolvedValue(true);
        await handlers['browser-credentials:save'](event, { username: 'new-account', password: 'new-secret' });
        expect(confirmSave.mock.calls[0][2]).toEqual({ oldPassword: undefined, newPassword: 'new-secret' });
        expect(vault.save).toHaveBeenCalledWith('https://example.com', 'new-account', 'new-secret');
    });
    it('requires save confirmation, distinguishes updates, and skips unchanged passwords', async () => {
        const handler = handlers['browser-credentials:save'];
        await handler(event, { username: 'alice', password: 'secret' });
        expect(confirmSave).not.toHaveBeenCalled();
        await handler(event, { username: 'alice', password: 'changed' });
        expect(confirmSave.mock.calls[0][2]).toEqual({ oldPassword: 'secret', newPassword: 'changed' });
        expect(vault.save).toHaveBeenCalledWith('https://example.com', 'alice', 'changed');
        vault.save.mockClear();
        confirmSave.mockResolvedValue(false);
        await handler(event, { username: 'alice', password: 'declined' });
        expect(vault.save).not.toHaveBeenCalled();
    });
    it.each([undefined, 'secret'])(
        'does not restore credentials after clearing a pending prompt (old: %s)',
        async (oldPassword) => {
            vault.get.mockReturnValue(oldPassword);
            let accept: any;
            confirmSave.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        accept = resolve;
                    })
            );
            const result = handlers['browser-credentials:save'](event, { username: 'alice', password: 'changed' });
            vault.clear();
            expect(confirmSave.mock.calls[0][3].aborted).toBe(true);
            accept(true);
            await result;
            expect(vault.save).not.toHaveBeenCalled();
        }
    );
    it('deduplicates concurrent update requests but allows a later explicit retry', async () => {
        let decline: any;
        confirmSave.mockImplementation(
            () =>
                new Promise((resolve) => {
                    decline = resolve;
                })
        );
        const candidate = { username: 'alice', password: 'changed' };
        const pending = handlers['browser-credentials:save'](event, candidate);
        await handlers['browser-credentials:save'](event, candidate);
        expect(confirmSave).toHaveBeenCalledTimes(1);
        decline(false);
        await pending;
        confirmSave.mockResolvedValue(true);
        await handlers['browser-credentials:save'](event, candidate);
        expect(confirmSave).toHaveBeenCalledTimes(2);
        expect(vault.save).toHaveBeenCalledWith('https://example.com', 'alice', 'changed');
    });
    it('does not write when encryption is unavailable', async () => {
        vault.available = () => false;
        await handlers['browser-credentials:save'](event, { username: 'alice', password: 'changed' });
        expect(showMessageBox.mock.calls[0][1].message).toBe('credentials.unavailable');
        expect(vault.save).not.toHaveBeenCalled();
    });
});

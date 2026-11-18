import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { Setting } from '../../../main/utils/setting.js';
import { logger } from '../../../main/utils/logger.js';

const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'opendesk-workspace-selection-'));
const oldWorkspace = path.join(workspaceRoot, 'old');
const nextWorkspace = path.join(workspaceRoot, 'next');
mkdirSync(oldWorkspace);
mkdirSync(nextWorkspace);
afterAll(() => rmSync(workspaceRoot, { recursive: true, force: true }));

const notifyWorkerSettingUpdate = jest.fn<(...args: unknown[]) => Promise<void>>();
const callWorker = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../../../main/applications/registry.js', () => ({
    ApplicationRegistry: { callWorker },
    notifyWorkerSettingUpdate
}));

const { applyWorkspaceSelection } = await import('../../../main/applications/settings/workspace.js');
const { notifyFileMgrEmbeddingConfigChanged } = await import('../../../main/applications/filemgr/embedding-config.js');

describe('shared workspace selection', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        notifyWorkerSettingUpdate.mockResolvedValue(undefined);
        callWorker.mockResolvedValue(undefined);
        Setting.updateInstanceData({
            default_workspace: oldWorkspace,
            gui_config: { recent_workspaces: [oldWorkspace, nextWorkspace] },
            applications: { filemgr: { entries: [{ root: oldWorkspace }] } }
        });
        jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        Setting.clearCache();
    });

    test('persists the default, recent paths and file manager entry before syncing workers', async () => {
        const save = jest.spyOn(Setting.getInstance(), 'setData');
        notifyWorkerSettingUpdate.mockImplementation(async (data, options) => {
            expect(data).toMatchObject({ default_workspace: nextWorkspace });
            expect(Setting.getInstance().getRecentWorkspaces()).toEqual([nextWorkspace, oldWorkspace]);
            expect(options).toEqual({ preferredSystemLanguages: ['zh-CN'] });
        });

        await applyWorkspaceSelection(nextWorkspace, { preferredSystemLanguages: ['zh-CN'] });

        const setting = Setting.getInstance();
        expect(setting.getEffectiveWorkspace()).toBe(nextWorkspace);
        const entries = (save.mock.calls[0][0] as { applications: { filemgr: { entries: Array<{ root: string }> } } })
            .applications.filemgr.entries;
        expect(entries).toHaveLength(2);
        expect(entries.map((entry) => entry.root).sort()).toEqual([oldWorkspace, nextWorkspace].sort());
        expect(callWorker).toHaveBeenCalledWith('filemgr', 'workspaceChanged', nextWorkspace);
    });

    test('reselecting the same workspace updates recents without another marker event', async () => {
        await applyWorkspaceSelection(oldWorkspace);

        expect(Setting.getInstance().getRecentWorkspaces()).toEqual([oldWorkspace, nextWorkspace]);
        expect(notifyWorkerSettingUpdate).toHaveBeenCalledTimes(1);
        expect(callWorker).not.toHaveBeenCalled();
    });

    test('a late earlier selection refreshes the current workspace rather than its saved snapshot', async () => {
        let resumeFirst!: () => void;
        let firstStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            firstStarted = resolve;
        });
        notifyWorkerSettingUpdate.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resumeFirst = resolve;
                    firstStarted();
                })
        );
        const first = applyWorkspaceSelection(nextWorkspace);
        await started;
        await applyWorkspaceSelection(oldWorkspace);
        resumeFirst();
        await first;

        expect(Setting.getInstance().getEffectiveWorkspace()).toBe(oldWorkspace);
        expect(callWorker).toHaveBeenLastCalledWith('filemgr', 'workspaceChanged', oldWorkspace);
    });

    test('propagates persistence failure without reporting or syncing the new workspace', async () => {
        jest.spyOn(Setting.getInstance(), 'setData').mockImplementation(() => {
            throw new Error('disk full');
        });

        await expect(applyWorkspaceSelection(nextWorkspace)).rejects.toThrow('disk full');

        expect(Setting.getInstance().getEffectiveWorkspace()).toBe(oldWorkspace);
        expect(notifyWorkerSettingUpdate).not.toHaveBeenCalled();
        expect(callWorker).not.toHaveBeenCalled();
    });

    test('continues marker refresh after settings sync fails because the selection was saved', async () => {
        notifyWorkerSettingUpdate.mockRejectedValue(new Error('worker offline'));

        await expect(applyWorkspaceSelection(nextWorkspace)).resolves.toBeUndefined();

        expect(Setting.getInstance().getEffectiveWorkspace()).toBe(nextWorkspace);
        expect(callWorker).toHaveBeenCalledWith('filemgr', 'workspaceChanged', nextWorkspace);
        expect(logger.warn).toHaveBeenCalledWith('[workspace] worker-settings-sync failed after save: worker offline');
    });

    test('a recent-list failure does not hide the persisted default or skip worker sync', async () => {
        jest.spyOn(Setting.getInstance(), 'addRecentWorkspace').mockImplementation(() => {
            throw new Error('recent write failed');
        });

        await expect(applyWorkspaceSelection(nextWorkspace)).resolves.toBeUndefined();

        expect(Setting.getInstance().getEffectiveWorkspace()).toBe(nextWorkspace);
        expect(notifyWorkerSettingUpdate).toHaveBeenCalledTimes(1);
        expect(callWorker).toHaveBeenCalledWith('filemgr', 'workspaceChanged', nextWorkspace);
    });

    test('a marker failure preserves success for the saved selection', async () => {
        callWorker.mockRejectedValue(new Error('marker unavailable'));

        await expect(applyWorkspaceSelection(nextWorkspace)).resolves.toBeUndefined();

        expect(Setting.getInstance().getEffectiveWorkspace()).toBe(nextWorkspace);
        expect(logger.warn).toHaveBeenCalledWith(
            '[workspace] filemgr-workspace-marker failed after save: marker unavailable'
        );
    });

    test('embedding notification compares effective model and provider configuration', async () => {
        const oldSettings = {
            default_embedding_model: 'embed',
            models: [{ alias: 'embed', model_name: 'embedding-a', provider_name: 'provider' }],
            providers: [{ name: 'provider', api_key: 'old' }]
        };
        await notifyFileMgrEmbeddingConfigChanged(oldSettings, { ...oldSettings, default_workspace: '/other' });
        expect(callWorker).not.toHaveBeenCalled();

        await notifyFileMgrEmbeddingConfigChanged(oldSettings, {
            ...oldSettings,
            providers: [{ name: 'provider', api_key: 'new' }]
        });
        expect(callWorker).toHaveBeenCalledWith('filemgr', 'embeddingConfigChanged');
    });
});

test('the Electron workspace setter returns an error when the shared save fails', async () => {
    const source = readFileSync(new URL('../../../main/main.ts', import.meta.url), 'utf8');
    const start = source.indexOf("ipcMain.handle('workspace:setWorkspaceDirectory'");
    const end = source.indexOf('ipcMain.handle(', start + 1);
    const handle = jest.fn();
    const applySelection = jest.fn(async () => {
        throw new Error('disk full');
    });
    runInNewContext(
        ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
            .outputText,
        {
            ipcMain: { handle },
            applyWorkspaceSelection: applySelection,
            getPreferredSystemLanguagesForLocale: () => ['zh-CN']
        }
    );
    const handler = handle.mock.calls[0][1] as (...args: unknown[]) => Promise<unknown>;

    expect(await handler({}, nextWorkspace)).toEqual({ status: 'error', message: 'disk full' });
    expect(applySelection).toHaveBeenCalledWith(nextWorkspace, { getPreferredSystemLanguages: expect.any(Function) });
});

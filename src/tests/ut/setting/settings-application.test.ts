import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { Setting } from '../../../main/utils/setting.js';
import { QuickPassHelper } from '../../../main/utils/quickpass.js';

const workspace = mkdtempSync(path.join(tmpdir(), 'opendesk-settings-application-'));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));
const notifyWorkerSettingUpdate = jest.fn<(...args: unknown[]) => Promise<void>>();
const callWorker = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const clearAdapterCache = jest.fn();
const onNetworkConfigChanged = jest.fn<() => Promise<void>>();
const reloadTelemetry = jest.fn<() => Promise<void>>();
const setDebugMode = jest.fn();
const warn = jest.fn();
jest.unstable_mockModule('../../../main/applications/registry.js', () => ({
    ApplicationRegistry: { callWorker },
    notifyWorkerSettingUpdate
}));
jest.unstable_mockModule('../../../main/aikernel/llm.js', () => ({ LLM: { clearAdapterCache } }));
jest.unstable_mockModule('../../../main/utils/proxy-env.js', () => ({ onNetworkConfigChanged }));
jest.unstable_mockModule('../../../main/telemetry/index.js', () => ({ reloadTelemetry }));
jest.unstable_mockModule('../../../main/utils/logger.js', () => ({ logger: { warn }, setDebugMode }));
const { saveSettingObject, importQuickPassConfiguration } =
    await import('../../../main/applications/settings/service.js');

describe('shared settings application', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        notifyWorkerSettingUpdate.mockResolvedValue(undefined);
        callWorker.mockResolvedValue(undefined);
        onNetworkConfigChanged.mockResolvedValue(undefined);
        reloadTelemetry.mockResolvedValue(undefined);
        Setting.updateInstanceData({ default_workspace: '' });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        Setting.clearCache();
    });

    test('saves before applying settings and preserves the detailed result contract', async () => {
        const applyTheme = jest.fn();
        notifyWorkerSettingUpdate.mockImplementation(async (data, options) => {
            expect(Setting.getInstance().getData().default_workspace).toBe(workspace);
            expect(data).toMatchObject({ default_workspace: workspace });
            expect(options).toEqual({ preferredSystemLanguages: ['zh-CN'] });
        });
        const result = await saveSettingObject(
            { ...Setting.getInstance().getData(), default_workspace: workspace },
            { applyTheme, preferredSystemLanguages: ['zh-CN'] }
        );

        expect(result).toMatchObject({ status: 'ok', data: { default_workspace: workspace }, sideEffectFailures: [] });
        expect(clearAdapterCache).toHaveBeenCalledTimes(1);
        expect(applyTheme).toHaveBeenCalledTimes(1);
        expect(callWorker).toHaveBeenCalledWith('filemgr', 'workspaceChanged', workspace);
    });

    test('a persistence failure runs no application steps', async () => {
        const applyTheme = jest.fn();
        jest.spyOn(Setting.getInstance(), 'setData').mockImplementation(() => {
            throw new Error('disk full');
        });

        expect(await saveSettingObject({}, { applyTheme })).toEqual({ status: 'error', message: 'disk full' });
        expect(clearAdapterCache).not.toHaveBeenCalled();
        expect(notifyWorkerSettingUpdate).not.toHaveBeenCalled();
        expect(applyTheme).not.toHaveBeenCalled();
        expect(onNetworkConfigChanged).not.toHaveBeenCalled();
    });

    test('worker synchronization reads the latest settings after an overlapping save', async () => {
        let resumeCache!: () => void;
        clearAdapterCache.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resumeCache = resolve;
                })
        );
        const firstSave = saveSettingObject(
            { ...Setting.getInstance().getData(), default_workspace: workspace },
            { applyTheme: () => undefined }
        );
        Setting.getInstance().setData({ ...Setting.getInstance().getData(), default_workspace: '' });
        resumeCache();

        await firstSave;

        expect(notifyWorkerSettingUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ default_workspace: '' }),
            expect.any(Object)
        );
    });

    test('an older save applies the latest debug value and returns the current settings', async () => {
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
        const initial = Setting.getInstance().getData();
        const first = saveSettingObject(
            { ...initial, debug: { ...initial.debug, debug_log: true } },
            { applyTheme: () => undefined }
        );
        await started;
        await saveSettingObject(
            { ...Setting.getInstance().getData(), debug: { ...initial.debug, debug_log: false } },
            { applyTheme: () => undefined }
        );
        resumeFirst();
        const result = await first;

        expect(Setting.getInstance().getData().debug.debug_log).toBe(false);
        expect(setDebugMode).toHaveBeenLastCalledWith(false);
        expect(result).toMatchObject({ status: 'ok', data: { debug: { debug_log: false } } });
    });

    test('worker synchronization resolves host languages after earlier save steps finish', async () => {
        let resumeCache!: () => void;
        let languages = ['en-US'];
        clearAdapterCache.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resumeCache = resolve;
                })
        );
        const saving = saveSettingObject(Setting.getInstance().getData(), {
            applyTheme: () => undefined,
            preferredSystemLanguages: ['en-US'],
            getPreferredSystemLanguages: () => languages
        });
        languages = ['zh-CN'];
        resumeCache();
        await saving;

        expect(notifyWorkerSettingUpdate).toHaveBeenCalledWith(expect.any(Object), {
            preferredSystemLanguages: ['zh-CN']
        });
    });

    test('an older settings save cannot restore an obsolete workspace marker', async () => {
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
        const first = saveSettingObject(
            { ...Setting.getInstance().getData(), default_workspace: workspace },
            { applyTheme: () => undefined }
        );
        await started;
        const newerWorkspace = path.join(workspace, 'newer');
        await saveSettingObject(
            { ...Setting.getInstance().getData(), default_workspace: newerWorkspace },
            { applyTheme: () => undefined }
        );
        resumeFirst();
        await first;

        expect(Setting.getInstance().getData().default_workspace).toBe(newerWorkspace);
        expect(callWorker).toHaveBeenLastCalledWith('filemgr', 'workspaceChanged', newerWorkspace);
    });

    test('a saved setting remains successful and later steps run after blocking failures', async () => {
        notifyWorkerSettingUpdate.mockRejectedValue(new Error('worker offline'));
        const applyTheme = jest.fn(async () => {
            throw new Error('theme unavailable');
        });

        const result = await saveSettingObject(
            { ...Setting.getInstance().getData(), default_workspace: workspace },
            { applyTheme }
        );

        expect(result).toMatchObject({
            status: 'ok',
            data: { default_workspace: workspace },
            sideEffectFailures: [
                { label: 'worker-settings-sync', message: 'worker offline' },
                { label: 'theme-apply', message: 'theme unavailable' }
            ]
        });
        expect(callWorker).toHaveBeenCalledWith('filemgr', 'workspaceChanged', workspace);
    });

    test('only applies debug mode when the saved value changes', async () => {
        const current = Setting.getInstance().getData();
        await saveSettingObject(current, { applyTheme: () => undefined });
        expect(setDebugMode).not.toHaveBeenCalled();

        await saveSettingObject(
            { ...current, debug: { ...current.debug, debug_log: true } },
            { applyTheme: () => undefined }
        );
        expect(setDebugMode).toHaveBeenCalledWith(true);
    });

    test('proxy and changed telemetry run in the background without delaying the save', async () => {
        let releaseProxy!: () => void;
        onNetworkConfigChanged.mockReturnValue(
            new Promise<void>((resolve) => {
                releaseProxy = resolve;
            })
        );
        const current = Setting.getInstance().getData();
        const result = await saveSettingObject(
            {
                ...current,
                telemetry: {
                    ...current.telemetry,
                    opentelemetry: { endpoints: [{ name: 'test', url: 'http://localhost:4318' }] }
                }
            },
            { applyTheme: () => undefined }
        );

        expect(result.status).toBe('ok');
        expect(onNetworkConfigChanged).toHaveBeenCalledTimes(1);
        expect(reloadTelemetry).not.toHaveBeenCalled();
        releaseProxy();
        await new Promise(setImmediate);
        expect(reloadTelemetry).toHaveBeenCalledTimes(1);
    });

    test('does not reload unchanged telemetry or emit duplicate setting callbacks', async () => {
        const callback = jest.fn();
        Setting.afterSetDataCallbacks.push(callback);
        try {
            await saveSettingObject(Setting.getInstance().getData(), { applyTheme: () => undefined });
            await new Promise(setImmediate);
            expect(reloadTelemetry).not.toHaveBeenCalled();
            expect(callback).toHaveBeenCalledTimes(1);
        } finally {
            Setting.afterSetDataCallbacks.splice(Setting.afterSetDataCallbacks.indexOf(callback), 1);
        }
    });

    test('imports a wrapped QuickPass and synchronizes the resulting settings', async () => {
        const quickpass = QuickPassHelper.exportQuickPass(
            'Shared settings',
            JSON.stringify({ default_workspace: workspace })
        );
        const wrapped = `  ${quickpass.slice(0, 20)}\n${quickpass.slice(20)}  `;

        expect(await importQuickPassConfiguration(wrapped, { preferredSystemLanguages: ['en-US'] })).toEqual({
            status: 'ok',
            data: { name: 'Shared settings', hasApplications: false }
        });
        expect(notifyWorkerSettingUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ default_workspace: workspace }),
            { preferredSystemLanguages: ['en-US'] }
        );
        expect(clearAdapterCache).not.toHaveBeenCalled();
        expect(onNetworkConfigChanged).not.toHaveBeenCalled();
    });

    test('reports an invalid QuickPass without applying settings', async () => {
        expect(await importQuickPassConfiguration('invalid')).toMatchObject({
            status: 'error',
            message: expect.any(String)
        });
        expect(notifyWorkerSettingUpdate).not.toHaveBeenCalled();
    });

    test('preserves the existing QuickPass error result when worker synchronization fails', async () => {
        notifyWorkerSettingUpdate.mockRejectedValue(new Error('worker offline'));
        const quickpass = QuickPassHelper.exportQuickPass(
            'Shared settings',
            JSON.stringify({ default_workspace: workspace })
        );

        expect(await importQuickPassConfiguration(quickpass)).toEqual({ status: 'error', message: 'worker offline' });
        expect(Setting.getInstance().getData().default_workspace).toBe(workspace);
    });
});

test('Electron adds resolved locale to the shared save result and supplies the theme adapter', async () => {
    const source = readFileSync(new URL('../../../main/main.ts', import.meta.url), 'utf8');
    const start = source.indexOf("ipcMain.handle('setting:saveSettingObject'");
    const end = source.indexOf('ipcMain.handle(', start + 1);
    const handle = jest.fn();
    const applyTheme = jest.fn();
    const save = jest.fn(
        async (
            _data: unknown,
            options: { applyTheme: () => unknown; getPreferredSystemLanguages?: () => readonly string[] }
        ) => {
            await options.applyTheme();
            expect(options.getPreferredSystemLanguages?.()).toEqual(['zh-CN']);
            return { status: 'ok', data: { default_workspace: workspace }, sideEffectFailures: [] };
        }
    );
    runInNewContext(
        ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
            .outputText,
        {
            ipcMain: { handle },
            saveSettingObject: save,
            getPreferredSystemLanguagesForLocale: () => ['zh-CN'],
            getMainThemeService: () => ({ applyFromSettings: applyTheme }),
            withResolvedLocale: (data: object) => ({ ...data, resolved_locale: 'zh-cn' })
        }
    );
    const handler = handle.mock.calls[0][1] as (...args: unknown[]) => Promise<unknown>;

    expect(await handler({}, { default_workspace: workspace })).toMatchObject({
        status: 'ok',
        data: { resolved_locale: 'zh-cn' }
    });
    expect(applyTheme).toHaveBeenCalledTimes(1);
});

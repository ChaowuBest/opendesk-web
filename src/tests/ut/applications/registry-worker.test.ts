import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { BaseApplication, BaseWorker } from '../../../main/applications/base.js';
import { ApplicationRegistry } from '../../../main/applications/registry.js';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

let workerlessConfigChangedCount = 0;
let workerBackedConfigChangedCount = 0;

class WorkerlessTestApplication extends BaseApplication {
    constructor() {
        super('workerless-test', false);
    }

    getName(): string {
        return 'Workerless Test';
    }

    static getConfigSchema(): z.ZodObject<any> {
        return z.object({
            enabled: z.boolean().default(true)
        });
    }

    onConfigChanged(): void {
        workerlessConfigChangedCount += 1;
    }
}

class WorkerBackedTestApplication extends BaseApplication {
    constructor() {
        super('worker-backed-test', false);
    }

    getName(): string {
        return 'Worker Backed Test';
    }

    static getWorkerClass(): typeof BaseWorker {
        return BaseWorker;
    }

    static getConfigSchema(): z.ZodObject<any> {
        return z.object({
            enabled: z.boolean().default(true)
        });
    }

    onConfigChanged(): void {
        workerBackedConfigChangedCount += 1;
    }
}

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-registry-worker-test-'));
}

describe('ApplicationRegistry worker notifications', () => {
    let tempDir: string;
    let originalApplications: Map<string, BaseApplication>;
    let originalGlobalWorker: typeof ApplicationRegistry.globalWorker;
    let originalCallbacks: Map<string, () => void>;

    beforeEach(() => {
        tempDir = makeTempDir();
        setCustomOpendeskDirectory(tempDir);
        Setting.clearCache();
        workerlessConfigChangedCount = 0;
        workerBackedConfigChangedCount = 0;
        originalApplications = ApplicationRegistry.applications;
        originalGlobalWorker = ApplicationRegistry.globalWorker;
        originalCallbacks = Setting.applicationConfigChangedCallbacks;
        ApplicationRegistry.applications = new Map();
        ApplicationRegistry.globalWorker = null;
        Setting.applicationConfigChangedCallbacks = new Map();
    });

    afterEach(() => {
        ApplicationRegistry.applications = originalApplications;
        ApplicationRegistry.globalWorker = originalGlobalWorker;
        Setting.applicationConfigChangedCallbacks = originalCallbacks;
        Setting.clearCache();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('does not notify global worker for applications without a worker class', () => {
        const postMessage = jest.fn();
        ApplicationRegistry.globalWorker = { postMessage } as any;
        ApplicationRegistry.registerApplication(new WorkerlessTestApplication());

        const setting = Setting.getInstance();
        setting.setData({
            ...setting.getData(),
            applications: {
                ...setting.getData().applications,
                'workerless-test': { enabled: false }
            }
        });

        expect(workerlessConfigChangedCount).toBe(1);
        expect(postMessage).not.toHaveBeenCalled();
    });

    test('keeps notifying global worker for applications with a worker class', () => {
        const postMessage = jest.fn();
        ApplicationRegistry.globalWorker = { postMessage } as any;
        ApplicationRegistry.registerApplication(new WorkerBackedTestApplication());

        const setting = Setting.getInstance();
        setting.setData({
            ...setting.getData(),
            applications: {
                ...setting.getData().applications,
                'worker-backed-test': { enabled: false }
            }
        });

        expect(workerBackedConfigChangedCount).toBe(1);
        expect(postMessage).toHaveBeenCalledWith({
            bundleName: 'worker-backed-test',
            methodName: 'applicationConfigChanged',
            args: [{ enabled: false }]
        });
    });

    test('callWorker returns before posting when application has no worker class', async () => {
        const postMessage = jest.fn();
        ApplicationRegistry.globalWorker = { postMessage } as any;
        ApplicationRegistry.registerApplication(new WorkerlessTestApplication());

        const result = await ApplicationRegistry.callWorker('workerless-test', 'applicationConfigChanged', {
            enabled: false
        });

        expect(result).toEqual({
            status: 'error',
            message: 'worker workerless-test not found'
        });
        expect(postMessage).not.toHaveBeenCalled();
    });
});

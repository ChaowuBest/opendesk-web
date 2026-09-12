import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    BUILTIN_PLUGINS_DIRECTORY_ENV,
    getBuiltinPluginsDirectory
} from '../../../main/applications/pluginmgr/management/paths.js';

describe('builtin plugin runtime path', () => {
    const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
    let root: string;
    let previousConfigured: string | undefined;
    let previousResourcesPath: string | undefined;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-paths-'));
        previousConfigured = process.env[BUILTIN_PLUGINS_DIRECTORY_ENV];
        previousResourcesPath = electronProcess.resourcesPath;
        delete process.env[BUILTIN_PLUGINS_DIRECTORY_ENV];
    });

    afterEach(() => {
        if (previousConfigured === undefined) delete process.env[BUILTIN_PLUGINS_DIRECTORY_ENV];
        else process.env[BUILTIN_PLUGINS_DIRECTORY_ENV] = previousConfigured;
        electronProcess.resourcesPath = previousResourcesPath;
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('keeps an explicit host override authoritative', () => {
        const packagedResources = path.join(root, 'packaged-resources');
        fs.mkdirSync(path.join(packagedResources, 'plugins'), { recursive: true });
        electronProcess.resourcesPath = packagedResources;

        const configured = path.join(root, 'verified-test-plugins');
        process.env[BUILTIN_PLUGINS_DIRECTORY_ENV] = configured;
        expect(getBuiltinPluginsDirectory()).toBe(configured);
    });

    test('uses an existing packaged Electron resources plugin directory', () => {
        const packagedResources = path.join(root, 'packaged-resources');
        const packagedPlugins = path.join(packagedResources, 'plugins');
        fs.mkdirSync(packagedPlugins, { recursive: true });
        electronProcess.resourcesPath = packagedResources;

        expect(getBuiltinPluginsDirectory()).toBe(packagedPlugins);
    });
});

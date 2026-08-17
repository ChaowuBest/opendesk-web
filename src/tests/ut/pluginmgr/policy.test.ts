import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    getPluginRuntimeEntry,
    setPluginGrantedCapabilities,
    setPluginOptions
} from '../../../main/applications/pluginmgr/management/policy.js';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

describe('plugin policy persistence', () => {
    let configDirectory: string;

    beforeEach(() => {
        configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-policy-'));
        setCustomOpendeskDirectory(configDirectory);
        Setting.clearCache();
    });

    afterEach(() => {
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(configDirectory, { recursive: true, force: true });
    });

    test('持久化插件配置及授权', () => {
        setPluginOptions('demo', { endpoint: 'global' });
        setPluginGrantedCapabilities('demo', ['tool', 'command']);

        expect(getPluginRuntimeEntry('demo')).toMatchObject({
            options: { endpoint: 'global' },
            granted_capabilities: ['tool', 'command']
        });

        Setting.clearCache();
        expect(getPluginRuntimeEntry('demo')?.options).toEqual({ endpoint: 'global' });
    });
});

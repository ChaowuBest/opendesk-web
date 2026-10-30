import fs from 'fs';
import os from 'os';
import path from 'path';
import { Setting, setCustomOpendeskDirectory } from '../../../../main/utils/setting';
import { SlashCommandRegistry } from '../../../../main/tui/commands/base';
import { registerDebugCommand } from '../../../../main/tui/commands/debug';
import { setRuntimeLocale } from '../../../../locale/index';

function useTempSettings(): string {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-debug-command-'));
    setCustomOpendeskDirectory(tempRoot);
    Setting.clearCache();
    Setting.updateInstanceData({
        debug: {
            developer_mode: false,
            experimental_features: {
                applications: { appmgr: false, agentoffice: false },
                account: false
            }
        }
    });
    return tempRoot;
}

describe('/debug command', () => {
    beforeEach(() => {
        setRuntimeLocale('en-US');
    });

    afterEach(() => {
        setRuntimeLocale(null);
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
    });

    test('toggles shared developer mode setting', async () => {
        const tempRoot = useTempSettings();
        const registry = new SlashCommandRegistry();
        registerDebugCommand({ commandRegistry: registry } as any);

        expect(await registry.execute('/debug developer on')).toBe(true);
        expect(Setting.getInstance().getData().debug.developer_mode).toBe(true);
        expect(JSON.parse(fs.readFileSync(path.join(tempRoot, 'setting.json'), 'utf8')).debug.developer_mode).toBe(
            true
        );

        expect(await registry.execute('/debug dev off')).toBe(true);
        expect(Setting.getInstance().getData().debug.developer_mode).toBe(false);
        expect(JSON.parse(fs.readFileSync(path.join(tempRoot, 'setting.json'), 'utf8')).debug.developer_mode).toBe(
            false
        );
    });

    test('completes developer mode toggle options', () => {
        useTempSettings();
        const registry = new SlashCommandRegistry();
        registerDebugCommand({ commandRegistry: registry } as any);

        const completions = registry.get('debug')?.getArgumentCompletions?.('developer ') ?? [];

        expect(completions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ value: 'developer on' }),
                expect.objectContaining({ value: 'developer off' })
            ])
        );
    });
});

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { registerPluginsCommand } from '../../../main/tui/subcommands/plugins.js';

describe('pluginmgr CLI', () => {
    test('opendesk plugins exposes plugin manager commands instead of OpenClaw commands', () => {
        const program = new Command();

        registerPluginsCommand(program);

        const plugins = program.commands.find((command) => command.name() === 'plugins');
        expect(plugins).toBeDefined();
        expect(plugins?.commands.map((command) => command.name())).toEqual([
            'install',
            'uninstall',
            'list',
            'enable',
            'disable',
            'config',
            'grant',
            'revoke',
            'verify',
            'doctor'
        ]);
        expect(plugins?.commands.some((command) => command.name() === 'reset-openclaw-shim')).toBe(false);
    });

    test('top-level plugins command is owned by PluginMgrApplication', () => {
        const cliSource = fs.readFileSync(path.resolve(process.cwd(), 'src/main/cli.ts'), 'utf8');

        expect(cliSource).not.toContain('registerPluginsCommand(prog);');
    });
});

import { jest } from '@jest/globals';
import { Command } from 'commander';
import { initializeServeTelemetry, registerServeCommand } from '../../../../main/tui/subcommands/serve.js';

describe('serve telemetry initialization', () => {
    test('waits for telemetry hooks to be installed before continuing', async () => {
        let resolveInitialization: (() => void) | undefined;
        const initializer = jest.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolveInitialization = resolve;
                })
        );
        let completed = false;
        const initialization = initializeServeTelemetry(initializer).then(() => {
            completed = true;
        });

        await Promise.resolve();
        expect(initializer).toHaveBeenCalledTimes(1);
        expect(completed).toBe(false);

        resolveInitialization?.();
        await initialization;
        expect(completed).toBe(true);
    });

    test('registers the config permission opt-in flag', () => {
        const program = new Command();
        registerServeCommand(program);

        const serve = program.commands.find((command) => command.name() === 'serve');
        expect(serve?.options.some((option) => option.long === '--use-config-permissions')).toBe(true);
    });

    test('registers the --model option for locking the model', () => {
        const program = new Command();
        registerServeCommand(program);

        const serve = program.commands.find((command) => command.name() === 'serve');
        expect(serve?.options.some((option) => option.long === '--model')).toBe(true);
    });

    test('does not redeclare --plugins-directory: the root option already applies after the subcommand', () => {
        const program = new Command();
        program.option('--plugins-directory <paths>');
        registerServeCommand(program);

        const serve = program.commands.find((command) => command.name() === 'serve');
        // 重复声明会让 serve 把选项抢走，导致 `--plugins-directory A serve --plugins-directory B`
        // 里根级别的值丢失；commander 默认解析整条 argv，根选项写在子命令之后同样生效。
        expect(serve?.options.some((option) => option.long === '--plugins-directory')).toBe(false);
    });

    test('does not redeclare --config-directory: the root option already applies after the subcommand', () => {
        const program = new Command();
        program.option('--config-directory <path>');
        registerServeCommand(program);

        const serve = program.commands.find((command) => command.name() === 'serve');
        expect(serve?.options.some((option) => option.long === '--config-directory')).toBe(false);
    });

    test('root options are still parsed when written after the subcommand name', () => {
        // serve 依赖这条 commander 行为：`opendesk serve --config-directory x` /
        // `opendesk serve --plugins-directory x` 等价于写在 serve 之前，因此不需要在
        // serve 上重复声明这两个选项。这里用等价结构固定该假设。
        const program = new Command();
        program.option('--config-directory <path>');
        program.option('--plugins-directory <paths>');
        program.command('serve').action(() => undefined);

        program.parse(['serve', '--config-directory', './data', '--plugins-directory', './team-plugins'], {
            from: 'user'
        });

        expect(program.opts()).toMatchObject({
            configDirectory: './data',
            pluginsDirectory: './team-plugins'
        });
    });
});

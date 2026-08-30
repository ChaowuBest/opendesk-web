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
});

import { jest } from '@jest/globals';
import { initializeServeTelemetry } from '../../../../main/tui/subcommands/serve.js';

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
});

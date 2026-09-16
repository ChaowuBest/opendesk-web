import { jest } from '@jest/globals';
import { enUs } from '../../../main/applications/terminal/locale/en-us.js';

const getStatus = jest.fn();
jest.unstable_mockModule('../../../main/applications/terminal/background.js', () => ({
    BackgroundProcessManager: class {
        static getInstance() {
            return { getStatus };
        }
    }
}));
jest.unstable_mockModule('../../../main/applications/terminal/locale/index.js', () => ({
    t: (key: string) => enUs[key] ?? key
}));

const { CheckShellStatusTool } = await import('../../../main/applications/terminal/shells/status.js');

test('only sandbox status results explain a rejected host drive path', async () => {
    getStatus.mockReturnValue({
        found: true,
        finished: true,
        exitCode: 1,
        elapsedMs: 1000,
        command: 'Get-Content C:\\file.txt',
        output: 'Access is denied: C:\\file.txt'
    });
    const sandboxResult = { updateResult: jest.fn() };
    const hostResult = { updateResult: jest.fn() };

    await new CheckShellStatusTool('powershell', true).executeCheck({ pid: 42, kill: false }, sandboxResult as any);
    await new CheckShellStatusTool('powershell', false).executeCheck({ pid: 42, kill: false }, hostResult as any);

    expect(sandboxResult.updateResult.mock.lastCall![0]).toContain(enUs['sandbox.pathErrorHint']);
    expect(hostResult.updateResult.mock.lastCall![0]).not.toContain(enUs['sandbox.pathErrorHint']);
});

test('does not use the echoed command as evidence of a rejected path', async () => {
    getStatus.mockReturnValue({
        found: true,
        finished: false,
        exitCode: null,
        elapsedMs: 1000,
        command: 'Get-Content C:\\file.txt',
        output: 'Access is denied'
    });
    const result = { updateResult: jest.fn() };

    await new CheckShellStatusTool('powershell', true).executeCheck({ pid: 42, kill: false }, result as any);

    expect(result.updateResult.mock.lastCall![0]).not.toContain(enUs['sandbox.pathErrorHint']);
});

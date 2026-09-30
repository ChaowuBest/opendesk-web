import { expect, it, jest } from '@jest/globals';

const loadElectron = jest.fn(() => {
    throw new Error('Electron is unavailable in CLI/Worker test environments');
});
jest.unstable_mockModule('electron', loadElectron);
jest.unstable_mockModule('node:module', () => ({ createRequire: () => loadElectron }));

it('imports credential runtime without loading Electron or initializing the vault', async () => {
    const runtime = await import('../../../main/services/browser-credentials/runtime.js');
    expect(typeof runtime.clearBrowserCredentials).toBe('function');
    expect(loadElectron).not.toHaveBeenCalled();
});

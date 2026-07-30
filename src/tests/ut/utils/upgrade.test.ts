import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { getConfiguredRegistry, compareVersions } from '../../../main/utils/upgrade';

describe('upgrade utils', () => {
    describe('getConfiguredRegistry', () => {
        let originalNpmConfigRegistry: string | undefined;
        let originalHomeDir: string | undefined;

        beforeEach(() => {
            originalNpmConfigRegistry = process.env.npm_config_registry;
            originalHomeDir = process.env.HOME;
        });

        afterEach(() => {
            if (originalNpmConfigRegistry !== undefined) {
                process.env.npm_config_registry = originalNpmConfigRegistry;
            } else {
                delete process.env.npm_config_registry;
            }
            if (originalHomeDir !== undefined) {
                process.env.HOME = originalHomeDir;
            }
        });

        test('uses npm_config_registry env var when set', () => {
            process.env.npm_config_registry = 'https://registry.npmmirror.com/';
            expect(getConfiguredRegistry()).toBe('https://registry.npmmirror.com');
        });

        test('reads registry from ~/.npmrc when env var not set', () => {
            delete process.env.npm_config_registry;
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-reg-test-'));
            process.env.HOME = tempHome;
            // Also need to mock os.homedir() which uses HOME on POSIX
            jest.spyOn(os, 'homedir').mockReturnValue(tempHome);

            fs.writeFileSync(
                path.join(tempHome, '.npmrc'),
                'registry=https://registry.npmmirror.com\nfetch-timeout=300000\n'
            );

            try {
                expect(getConfiguredRegistry()).toBe('https://registry.npmmirror.com');
            } finally {
                jest.restoreAllMocks();
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('handles quoted registry in .npmrc', () => {
            delete process.env.npm_config_registry;
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-reg-test-'));
            jest.spyOn(os, 'homedir').mockReturnValue(tempHome);

            fs.writeFileSync(path.join(tempHome, '.npmrc'), 'registry="https://registry.npmmirror.com"\n');

            try {
                expect(getConfiguredRegistry()).toBe('https://registry.npmmirror.com');
            } finally {
                jest.restoreAllMocks();
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('defaults to registry.npmjs.org when no config found', () => {
            delete process.env.npm_config_registry;
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-reg-test-'));
            jest.spyOn(os, 'homedir').mockReturnValue(tempHome);

            try {
                expect(getConfiguredRegistry()).toBe('https://registry.npmjs.org');
            } finally {
                jest.restoreAllMocks();
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('strips trailing slashes from registry URL', () => {
            process.env.npm_config_registry = 'https://registry.example.com///';
            expect(getConfiguredRegistry()).toBe('https://registry.example.com');
        });
    });

    describe('compareVersions', () => {
        test('compares semantic versions correctly', () => {
            expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
            expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
            expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
            expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
            expect(compareVersions('1.9.9', '2.0.0')).toBe(-1);
        });

        test('nightly versions are newer than stable of same base', () => {
            expect(compareVersions('1.0.0-nightly-20260729', '1.0.0')).toBe(1);
            expect(compareVersions('1.0.0', '1.0.0-nightly-20260729')).toBe(-1);
        });

        test('compares nightly dates correctly', () => {
            expect(compareVersions('1.0.0-nightly-20260730', '1.0.0-nightly-20260729')).toBe(1);
            expect(compareVersions('1.0.0-nightly-20260729', '1.0.0-nightly-20260730')).toBe(-1);
        });
    });
});

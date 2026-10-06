import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOpendeskDirectory } from '../../main/utils/setting.js';

describe('test environment isolation', () => {
    test('jest test runs must resolve the app data directory into an isolated temp directory', () => {
        const directory = process.env.OPENDESK_CONFIG_DIRECTORY;
        expect(directory).toBeDefined();

        const tempRoot = path.resolve(os.tmpdir());
        const resolved = path.resolve(directory!);
        expect(resolved === tempRoot || resolved.startsWith(tempRoot + path.sep)).toBe(true);

        expect(fs.existsSync(resolved)).toBe(true);
        expect(path.resolve(getOpendeskDirectory())).toBe(resolved);
    });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getOpendeskDirectory, setCustomOpendeskDirectory } from '../../../../main/utils/setting.js';

test('OPENDESK_CONFIG_DIRECTORY selects the GUI configuration directory', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-config-directory-test-'));
    const originalCanonical = process.env.OPENDESK_CONFIG_DIRECTORY;
    const originalMisspelled = process.env.OPENDDESK_CONFIG_DIRECTORY;

    try {
        setCustomOpendeskDirectory(undefined);
        process.env.OPENDESK_CONFIG_DIRECTORY = tempDir;
        delete process.env.OPENDDESK_CONFIG_DIRECTORY;

        assert.equal(getOpendeskDirectory(), tempDir);
    } finally {
        setCustomOpendeskDirectory(undefined);
        if (originalCanonical === undefined) {
            delete process.env.OPENDESK_CONFIG_DIRECTORY;
        } else {
            process.env.OPENDESK_CONFIG_DIRECTORY = originalCanonical;
        }
        if (originalMisspelled === undefined) {
            delete process.env.OPENDDESK_CONFIG_DIRECTORY;
        } else {
            process.env.OPENDDESK_CONFIG_DIRECTORY = originalMisspelled;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

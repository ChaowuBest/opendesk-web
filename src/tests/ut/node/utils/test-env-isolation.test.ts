import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getOpendeskDirectory } from '../../../../main/utils/setting.js';

test('node test runs must resolve the app data directory into an isolated temp directory', () => {
    const resolved = path.resolve(getOpendeskDirectory());
    const tempRoot = path.resolve(os.tmpdir());
    assert.ok(
        resolved === tempRoot || resolved.startsWith(tempRoot + path.sep),
        `expected the test app data directory to stay under "${tempRoot}", got "${resolved}". ` +
            'Run node tests through `npm run test:node`, which injects src/tests/test-env.ts via --import ' +
            'to keep test writes away from the real user data directory.'
    );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    __resetForTesting,
    getDefaultWorkspace,
    getEntries,
    getPlatform,
    getSystemHomePath,
    setDefaultWorkspace,
    setEntries,
    syncStateFromSnapshot
} from '../../../../../main/applications/filemgr/renderer/state.js';

test.afterEach(__resetForTesting);
test('snapshot contributes platform metadata without changing settings selection', () => {
    setEntries([{ root: '/draft' }]);
    setDefaultWorkspace('/settings');
    syncStateFromSnapshot({
        platform: 'darwin',
        is_openharmony: false,
        home_path: '/home',
        default_workspace: '/stale',
        sources: [{ root: '/stale' }]
    });
    assert.deepEqual(getEntries(), [{ root: '/draft' }]);
    assert.equal(getDefaultWorkspace(), '/settings');
    assert.equal(getPlatform(), 'darwin');
    assert.equal(getSystemHomePath(), '/home');
});

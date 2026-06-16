/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    clearPendingCommit,
    getDefaultWorkspace,
    getEntries,
    setDefaultWorkspace,
    setEntries,
    setPendingCommit,
    setSnapshot,
    subscribeEntries,
    syncStateFromSnapshot
} from '../../../../../main/applications/filemgr/renderer/state.js';

function resetState() {
    clearPendingCommit();
    setSnapshot(null);
    setEntries([]);
    setDefaultWorkspace('');
}

test.beforeEach(resetState);
test.afterEach(resetState);

test('syncStateFromSnapshot updates entries and default workspace from worker snapshot', () => {
    setEntries([{ root: '/old-workspace', include_patterns: ['**/*.md'], exclude_patterns: [] }]);
    setDefaultWorkspace('/old-workspace');
    let entriesNotifications = 0;
    const unsubscribe = subscribeEntries(() => {
        entriesNotifications++;
    });

    try {
        const result = syncStateFromSnapshot({
            status: 'running',
            default_workspace: '/new-workspace',
            sources: [
                {
                    root: '/new-workspace',
                    entry: {
                        root: '/new-workspace',
                        include_patterns: ['**/*'],
                        exclude_patterns: ['**/.git/**']
                    }
                },
                {
                    root: '/docs'
                }
            ]
        });

        assert.equal(result.entriesUpdated, true);
        assert.equal(result.defaultWorkspaceUpdated, true);
        assert.deepEqual(
            getEntries().map((entry) => entry.root),
            ['/new-workspace', '/docs']
        );
        assert.deepEqual(getEntries()[0].include_patterns, ['**/*']);
        assert.equal(getDefaultWorkspace(), '/new-workspace');
        assert.equal(entriesNotifications, 1);
    } finally {
        unsubscribe();
    }
});

test('syncStateFromSnapshot preserves pending entries while updating default workspace', () => {
    setEntries([{ root: '/old-workspace' }]);
    setDefaultWorkspace('/old-workspace');
    setPendingCommit([{ root: '/pending-choice' }]);

    const result = syncStateFromSnapshot({
        status: 'running',
        default_workspace: '/new-workspace',
        sources: [{ root: '/new-workspace', entry: { root: '/new-workspace' } }]
    });

    assert.equal(result.entriesUpdated, false);
    assert.equal(result.entriesSkippedBecausePending, true);
    assert.deepEqual(getEntries(), [{ root: '/old-workspace' }]);
    assert.equal(getDefaultWorkspace(), '/new-workspace');
});

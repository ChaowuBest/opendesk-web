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
import { FSEntrySchema } from '../../../../main/applications/filemgr/setting.js';
import {
    prepareFileMgrStartupWorkspaceSettings,
    prepareFileMgrWorkspaceSettings,
    upsertDefaultWorkspaceFileMgrEntry
} from '../../../../main/applications/filemgr/workspace.js';

test('prepareFileMgrWorkspaceSettings backfills workspace entries and notification state', () => {
    const cases = [
        {
            name: 'append new default workspace',
            oldSettings: { default_workspace: '/old', applications: { filemgr: { entries: [] } } },
            nextSettings: { default_workspace: '/new-workspace', applications: { filemgr: { entries: [] } } },
            expectedDefaultWorkspace: '/new-workspace',
            expectedNotify: true,
            expectedRoots: ['/new-workspace']
        },
        {
            name: 'preserve existing workspace entry configuration',
            oldSettings: {
                default_workspace: '/old',
                applications: {
                    filemgr: {
                        entries: [{ root: '/existing', include_patterns: ['**/*.md'], exclude_patterns: ['custom/**'] }]
                    }
                }
            },
            nextSettings: {
                default_workspace: '/existing',
                applications: {
                    filemgr: {
                        entries: [{ root: '/existing', include_patterns: ['**/*.md'], exclude_patterns: ['custom/**'] }]
                    }
                }
            },
            expectedDefaultWorkspace: '/existing',
            expectedNotify: true,
            expectedRoots: ['/existing'],
            expectedExcludes: ['custom/**']
        },
        {
            name: 'skip empty default workspace',
            oldSettings: { default_workspace: '/old', applications: { filemgr: { entries: [{ root: '/old' }] } } },
            nextSettings: { default_workspace: '', applications: { filemgr: { entries: [{ root: '/old' }] } } },
            expectedDefaultWorkspace: null,
            expectedNotify: false,
            expectedRoots: ['/old']
        },
        {
            name: 'unchanged workspace still backfills without notifying',
            oldSettings: { default_workspace: '/workspace', applications: { filemgr: { entries: [] } } },
            nextSettings: { default_workspace: '/workspace', applications: { filemgr: { entries: [] } } },
            expectedDefaultWorkspace: '/workspace',
            expectedNotify: false,
            expectedRoots: ['/workspace']
        },
        {
            name: 'settings save payload preserves other application config',
            oldSettings: { default_workspace: '/old', applications: { filemgr: { entries: [] } } },
            nextSettings: { default_workspace: '/imported-workspace', applications: { other: { enabled: true } } },
            expectedDefaultWorkspace: '/imported-workspace',
            expectedNotify: true,
            expectedRoots: ['/imported-workspace'],
            expectedOtherEnabled: true
        }
    ];

    for (const testCase of cases) {
        const result = prepareFileMgrWorkspaceSettings(testCase.nextSettings, testCase.oldSettings);
        const entries = result.data.applications.filemgr.entries;

        assert.equal(result.defaultWorkspace, testCase.expectedDefaultWorkspace, testCase.name);
        assert.equal(result.shouldNotifyWorkspaceChanged, testCase.expectedNotify, testCase.name);
        assert.deepEqual(
            entries.map((entry) => entry.root),
            testCase.expectedRoots,
            testCase.name
        );
        assert.equal(
            entries.some((entry) => Object.hasOwn(entry, 'is_workspace')),
            false,
            testCase.name
        );
        if (testCase.expectedExcludes) {
            assert.deepEqual(entries[0].exclude_patterns, testCase.expectedExcludes, testCase.name);
        }
        if (testCase.expectedOtherEnabled) {
            assert.equal(result.data.applications.other.enabled, true, testCase.name);
        }
    }
});

test('prepareFileMgrStartupWorkspaceSettings backfills upgraded users only when needed', () => {
    const missingEntry = { default_workspace: '/workspace', applications: { filemgr: { entries: [] } } };
    const existingEntry = {
        default_workspace: '/workspace',
        applications: { filemgr: { entries: [{ root: '/workspace' }] } }
    };

    const backfilled = prepareFileMgrStartupWorkspaceSettings(missingEntry);
    assert.equal(backfilled.changed, true);
    assert.deepEqual(
        backfilled.data.applications.filemgr.entries.map((entry) => entry.root),
        ['/workspace']
    );
    assert.equal(backfilled.defaultWorkspace, '/workspace');

    const noOp = prepareFileMgrStartupWorkspaceSettings(existingEntry);
    assert.equal(noOp.changed, false);
    assert.equal(noOp.data, existingEntry);
});

test('upsertDefaultWorkspaceFileMgrEntry keeps picker semantics through prepare helper', () => {
    const settingData = { default_workspace: '/old', applications: { filemgr: { entries: [] } } };

    const result = upsertDefaultWorkspaceFileMgrEntry(settingData, '/picker-workspace');
    const entries = result.data.applications.filemgr.entries;

    assert.equal(result.data.default_workspace, '/picker-workspace');
    assert.equal(result.defaultWorkspaceChanged, true);
    assert.equal(result.entriesChanged, true);
    assert.equal(
        entries.some((entry) => entry.root === '/picker-workspace'),
        true
    );
});

test('prepareFileMgrWorkspaceSettings removes child workspace entry when switching to parent without user excludes', () => {
    const childEntry = FSEntrySchema.parse({ root: '/A/B' });
    const oldSettings = {
        default_workspace: '/A/B',
        applications: {
            filemgr: {
                entries: [childEntry]
            }
        }
    };
    const nextSettings = { ...oldSettings, default_workspace: '/A' };

    const result = prepareFileMgrWorkspaceSettings(nextSettings, oldSettings);
    const roots = result.data.applications.filemgr.entries.map((entry) => entry.root);

    assert.deepEqual(roots, ['/A']);
});

test('prepareFileMgrWorkspaceSettings merges child workspace user excludes into parent workspace', () => {
    const childEntry = FSEntrySchema.parse({
        root: '/A/B',
        exclude_patterns: ['**/node_modules/**', '**/.git/**', 'dist/**', 'node_modules/**']
    });
    const oldSettings = {
        default_workspace: '/A/B',
        applications: {
            filemgr: {
                entries: [childEntry]
            }
        }
    };
    const nextSettings = { ...oldSettings, default_workspace: '/A' };

    const result = prepareFileMgrWorkspaceSettings(nextSettings, oldSettings);
    const entries = result.data.applications.filemgr.entries;
    const parentEntry = entries.find((entry) => entry.root === '/A');

    assert.equal(
        entries.some((entry) => entry.root === '/A/B'),
        false
    );
    assert.ok(parentEntry.exclude_patterns.includes('**/node_modules/**'));
    assert.ok(parentEntry.exclude_patterns.includes('B/dist/**'));
    assert.ok(parentEntry.exclude_patterns.includes('B/node_modules/**'));
});

test('prepareFileMgrWorkspaceSettings keeps parent root when switching from parent workspace to child workspace', () => {
    const oldSettings = {
        default_workspace: '/A',
        applications: {
            filemgr: {
                entries: [{ root: '/A', exclude_patterns: ['custom/**'] }]
            }
        }
    };
    const nextSettings = { ...oldSettings, default_workspace: '/A/B' };

    const result = prepareFileMgrWorkspaceSettings(nextSettings, oldSettings);
    const roots = result.data.applications.filemgr.entries.map((entry) => entry.root);

    assert.deepEqual(roots, ['/A', '/A/B']);
});

test('prepareFileMgrWorkspaceSettings keeps unrelated old workspace root when switching workspace', () => {
    const oldSettings = {
        default_workspace: '/A/B',
        applications: {
            filemgr: {
                entries: [{ root: '/A/B', exclude_patterns: ['custom/**'] }]
            }
        }
    };
    const nextSettings = { ...oldSettings, default_workspace: '/C' };

    const result = prepareFileMgrWorkspaceSettings(nextSettings, oldSettings);
    const roots = result.data.applications.filemgr.entries.map((entry) => entry.root);

    assert.deepEqual(roots, ['/A/B', '/C']);
});

test('prepareFileMgrWorkspaceSettings deduplicates merged child workspace excludes', () => {
    const oldSettings = {
        default_workspace: '/A/B',
        applications: {
            filemgr: {
                entries: [
                    { root: '/A', exclude_patterns: ['B/dist/**'] },
                    { root: '/A/B', exclude_patterns: ['dist/**'] }
                ]
            }
        }
    };
    const nextSettings = { ...oldSettings, default_workspace: '/A' };

    const result = prepareFileMgrWorkspaceSettings(nextSettings, oldSettings);
    const entries = result.data.applications.filemgr.entries;
    const parentEntry = entries.find((entry) => entry.root === '/A');

    assert.equal(
        entries.some((entry) => entry.root === '/A/B'),
        false
    );
    assert.deepEqual(parentEntry.exclude_patterns, ['B/dist/**']);
});

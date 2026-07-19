import test from 'node:test';
import assert from 'node:assert/strict';
import { isTaskVisibleForDeveloperMode } from '../../../main/aikernel/states/tasks.js';

test('hides internal tasks from normal mode', () => {
    assert.equal(isTaskVisibleForDeveloperMode({ internal: true }, false), false);
    assert.equal(isTaskVisibleForDeveloperMode({ internal: false }, false), true);
    assert.equal(isTaskVisibleForDeveloperMode({}, false), true);
});

test('shows internal tasks in developer mode', () => {
    assert.equal(isTaskVisibleForDeveloperMode({ internal: true }, true), true);
});

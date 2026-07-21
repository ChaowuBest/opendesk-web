/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { SkillRegistry } from '../../../../main/aikernel/skill.js';
import { isWorkflowEnabled, registerWorkflowSkillGate } from '../../../../main/applications/workflow/feature.js';
import { Setting } from '../../../../main/utils/setting.js';

test('Workflow reuses the global experimental feature switch through one scoped Skill gate', () => {
    const originalSetting = Setting.instance;
    const originalFilters = [...SkillRegistry.skillFilters];
    try {
        Setting.instance = new Setting();
        const data = Setting.instance.getData() as {
            debug: { experimental_feature: boolean };
        };
        data.debug.experimental_feature = false;

        registerWorkflowSkillGate();
        const workflowFilter = SkillRegistry.skillFilters.at(-1);

        assert.equal(isWorkflowEnabled(), false);
        assert.equal(workflowFilter?.('workflow', 'workflow'), false);
        assert.equal(workflowFilter?.('mailbox', 'mail'), true);

        data.debug.experimental_feature = true;

        assert.equal(isWorkflowEnabled(), true);
        assert.equal(workflowFilter?.('workflow', 'deep-research'), true);
    } finally {
        Setting.instance = originalSetting;
        SkillRegistry.skillFilters = originalFilters;
    }
});

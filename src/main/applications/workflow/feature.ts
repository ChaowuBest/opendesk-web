/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * 职责：集中管理 Workflow 对外暴露的试验性功能开关。
 */

import { SkillRegistry } from '../../aikernel/skill.js';
import { Setting } from '../../utils/setting.js';
import { t } from '../../../locale/index.js';

const WORKFLOW_BUNDLE_NAME = 'workflow';
let skillGateRegistered = false;

export function isWorkflowEnabled(): boolean {
    try {
        const setting = Setting.getInstance().getData() as {
            debug?: { experimental_feature?: boolean };
        };
        return setting.debug?.experimental_feature === true;
    } catch {
        return false;
    }
}

export function assertWorkflowEnabled(): void {
    if (!isWorkflowEnabled()) {
        throw new Error(t('workflow.error.experimentalDisabled'));
    }
}

export function registerWorkflowSkillGate(): void {
    if (skillGateRegistered) {
        return;
    }
    SkillRegistry.registerSkillFilter((bundleName) => bundleName !== WORKFLOW_BUNDLE_NAME || isWorkflowEnabled());
    skillGateRegistered = true;
}

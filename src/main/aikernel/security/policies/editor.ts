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

/**
 * 编辑器/IDE CLI 策略（code 等，standard 模式）。
 *
 * VS Code 扩展目录三平台一致（{home}/.vscode/extensions，CLI 与 GUI 共用）；
 * code CLI（code --install-extension 等）高频读。User 配置目录（settings.json）
 * 按平台分裂——token 存系统钥匙串/DPAPI 不落盘，settings.json 本身低敏但可能
 * 含代理配置，【待收紧】当前从宽放行 extensions 与 User 配置。
 */

import type { PermissionRule } from '../permission.js';
import { homeRules } from './common.js';

/** 编辑器 CLI 运行时读放行（扩展目录、用户配置）。 */
const EDITOR_RUNTIME_READ_PATTERNS = [
    '{home}/.vscode/extensions/**',
    '{home}/AppData/Roaming/Code/User/**',
    '{home}/Library/Application Support/Code/User/**',
    '{home}/.config/Code/User/**',
    // OpenDesk 自带 interpreters 的编辑器集成（如有）
    '{home}/.vscode-server/**'
];

export function createEditorPolicyRules(homeDir?: string): PermissionRule[] {
    return homeRules(EDITOR_RUNTIME_READ_PATTERNS, 'read', 'allow', homeDir);
}

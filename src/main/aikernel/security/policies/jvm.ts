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
 * JVM 构建工具策略（java/javac/mvn/gradle，standard 模式）。
 *
 * 三平台布局：{home}/.m2 与 {home}/.gradle 三平台一致（官方文档验证）。
 * java 本体读系统目录（JAVA_HOME/jvm 目录），无用户目录凭据文件。
 *
 * 凭据边界：
 * - ~/.m2/settings-security.xml（Maven 主密码，可解密 settings.xml 加密密码）ask；
 * - ~/.m2/settings.xml 与 ~/.gradle/gradle.properties 常含仓库凭据/代理密码，
 *   【待收紧】当前从宽放行（repository/caches 高频读更关键），统一审视时评估
 *   改为 ask 或按节脱敏；
 * - ~/.m2/repository 与 ~/.gradle/caches 为纯下载产物，放行。
 */

import type { PermissionRule } from '../permission.js';
import { homeRules } from './common.js';

/** Maven 主密码：读 ask 保护。 */
const JVM_CREDENTIAL_ASK_PATTERNS = ['{home}/.m2/settings-security.xml'];

/** JVM 构建工具运行时读放行（本地仓库、缓存、wrapper dists）。 */
const JVM_RUNTIME_READ_PATTERNS = [
    '{home}/.m2/repository/**',
    '{home}/.m2/settings.xml',
    '{home}/.gradle/caches/**',
    '{home}/.gradle/wrapper/**',
    '{home}/.gradle/gradle.properties',
    '{home}/.gradle/daemon/**',
    '{home}/.jdks/**',
    '{home}/.java/**'
];

export function createJvmPolicyRules(homeDir?: string): PermissionRule[] {
    return [
        ...homeRules(JVM_CREDENTIAL_ASK_PATTERNS, 'read', 'ask', homeDir),
        ...homeRules(JVM_RUNTIME_READ_PATTERNS, 'read', 'allow', homeDir)
    ];
}

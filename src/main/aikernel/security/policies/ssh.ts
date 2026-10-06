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
 * SSH 运行时策略（ssh/scp/sftp，standard 模式）。
 *
 * 三平台实测与 OpenSSH 通用布局：~/.ssh 为三平台统一目录（Windows 10+ OpenSSH
 * 同用）。ssh 每次连接读 config（主机别名/用户/端口）与 known_hosts（主机公钥
 * 指纹校验），均为低敏高频读。
 *
 * 凭据边界：私钥（id_* 非 .pub、*.pem）与证书（*-cert.pub）由宿主敏感清单
 * （SENSITIVE_PATH_PATTERNS 的 ~/.ssh/**）read ask 保护，本策略不放行它们——
 * 只对两个低敏文件做精确放行（前缀模式更具体，most-specific 下优先命中）。
 *
 * 【待收紧】~/.ssh/config 可经 Include 指令引用任意文件且 IdentityFile 指向
 * 私钥路径——config 本身无凭据但属"审查类"，当前从宽放行，统一审视时可改为
 * ask 或解析 Include 后收窄。
 */

import type { PermissionRule } from '../permission.js';
import { homeRules } from './common.js';

/** SSH 低敏运行时读放行（私钥/证书不在清单内，由敏感清单 ask 保护）。 */
const SSH_RUNTIME_READ_PATTERNS = ['{home}/.ssh/config', '{home}/.ssh/known_hosts', '{home}/.ssh/known_hosts.old'];

export function createSshPolicyRules(homeDir?: string): PermissionRule[] {
    return homeRules(SSH_RUNTIME_READ_PATTERNS, 'read', 'allow', homeDir);
}

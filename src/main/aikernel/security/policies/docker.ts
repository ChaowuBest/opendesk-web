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
 * 容器工具策略（docker/podman CLI，standard 模式）。
 *
 * 三平台布局一致（{home}/.docker；Docker Desktop 同）。docker CLI 每次调用读
 * config.json（当前 context/连接配置）。
 *
 * 凭据边界：~/.docker/config.json 的 auths 字段可含 base64 明文 registry 凭据、
 * key.pem 是 TLS 客户端私钥——【待收紧】docker 日常使用（ps/build/logs）每次
 * 都读 config.json，严格 ask 会让所有 docker 命令弹窗。当前从宽放行 config.json
 * 与 contexts（daemon 连接信息），key.pem/ca.pem/cert.pem 保持敏感清单外的
 * 兜底 ask（不在 allow 清单）。统一审视时评估：只放行非 auth 场景或整类 ask。
 */

import type { PermissionRule } from '../permission.js';
import { homeRules } from './common.js';

/** docker 运行时读放行（CLI 配置与上下文；私钥/证书不在清单）。 */
const DOCKER_RUNTIME_READ_PATTERNS = [
    '{home}/.docker/config.json',
    '{home}/.docker/daemon.json',
    '{home}/.docker/contexts/**',
    '{home}/.docker/cli-plugins/**'
];

export function createDockerPolicyRules(homeDir?: string): PermissionRule[] {
    return homeRules(DOCKER_RUNTIME_READ_PATTERNS, 'read', 'allow', homeDir);
}

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

import { logger } from '../../../../../utils/logger.js';

// Deliberately project diagnostics: no thrown object, credentials, SDP or Session content is logged.
export function logTuiRemoteDiagnostic(scope: 'network' | 'lifecycle' | 'session', event: unknown): void {
    const value = event as {
        code?: unknown;
        kind?: unknown;
        category?: unknown;
        count?: unknown;
        phase?: unknown;
        step?: unknown;
    } | null;
    const code = value?.code ?? value?.category ?? value?.kind;
    if (typeof code !== 'string' || !/^[a-z_][a-z_0-9]{0,63}$/.test(code)) return;
    if (scope === 'session' && code !== 'execution_node_unavailable' && code !== 'task_assembly_failed') return;
    const tag =
        scope === 'network'
            ? '[TuiRemoteNetwork]'
            : scope === 'lifecycle'
              ? '[TuiRemoteLifecycle]'
              : '[TuiSessionCreation]';
    let line = `${tag} ${code}`;
    if (
        scope === 'session' &&
        code === 'task_assembly_failed' &&
        (value?.step === 'init_harness' ||
            value?.step === 'set_execution_host' ||
            value?.step === 'rebuild_system_prompt' ||
            value?.step === 'publish_task_list')
    ) {
        line += ` step=${value.step}`;
    }
    if (value?.phase === 'prepare' || value?.phase === 'readiness' || value?.phase === 'start') {
        line += ` phase=${value.phase}`;
    }
    if (typeof value?.count === 'number' && Number.isSafeInteger(value.count) && value.count >= 0) {
        line += ` count=${value.count}`;
    }
    try {
        // logger 的格式器只保留 message，有限字段必须拼到同一条消息中。
        logger.warn(line);
    } catch {
        // 诊断写入失败不影响远程链路。
    }
}

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

import { AgentExecutionInstrumentationRegistry, type AgentExecutionInstrumentation } from './agent-execution.js';
import { TelemetryOperationRegistry, type OperationInstrumentation } from './operation.js';

export interface TelemetryProtocol {
    readonly name: string;
    readonly agentExecutionInstrumentations?: readonly AgentExecutionInstrumentation[];
    readonly operationInstrumentations?: readonly OperationInstrumentation[];
    shutdown(): Promise<void>;
}

export function installProtocols(protocols: readonly TelemetryProtocol[]): void {
    AgentExecutionInstrumentationRegistry.install(
        protocols.flatMap((protocol) => protocol.agentExecutionInstrumentations ?? [])
    );
    TelemetryOperationRegistry.install(protocols.flatMap((protocol) => protocol.operationInstrumentations ?? []));
}

export async function shutdownProtocols(protocols: readonly TelemetryProtocol[]): Promise<void> {
    AgentExecutionInstrumentationRegistry.reset();
    TelemetryOperationRegistry.reset();
    for (const protocol of [...protocols].reverse()) {
        await protocol.shutdown();
    }
}

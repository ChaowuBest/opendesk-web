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

import { LangfuseSpanProcessor, isLangfuseSpan } from '@langfuse/otel';
import { setLangfuseTracerProvider } from '@langfuse/tracing';
import type { LangfuseConfig } from '../../utils/setting.js';
import { logger } from '../../utils/logger.js';
import type { OpenTelemetryProtocolIntegration } from '../opentelemetry/init.js';
import { resolveLangfuseConfig, type LangfuseRuntimeConfig } from './config.js';

let activeConfig: LangfuseRuntimeConfig | undefined;
let activeProcessors: LangfuseSpanProcessor[] = [];
let processHooksRegistered = false;

function errorToMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function registerProcessHooks(): void {
    if (processHooksRegistered) {
        return;
    }
    processHooksRegistered = true;
    process.once('beforeExit', () => {
        void flushLangfuseTelemetry();
    });
}

export async function initLangfuse(fileConfig: LangfuseConfig): Promise<OpenTelemetryProtocolIntegration | undefined> {
    const config = resolveLangfuseConfig(fileConfig);
    if (!config) {
        activeConfig = undefined;
        activeProcessors = [];
        return undefined;
    }

    const processors: LangfuseSpanProcessor[] = [];
    const initializedEndpoints: LangfuseRuntimeConfig['endpoints'] = [];
    for (const endpoint of config.endpoints) {
        try {
            processors.push(
                new LangfuseSpanProcessor({
                    publicKey: endpoint.publicKey,
                    secretKey: endpoint.secretKey,
                    baseUrl: endpoint.baseUrl,
                    environment: config.environment,
                    flushAt: endpoint.flushAt,
                    flushInterval: endpoint.flushInterval,
                    exportMode: endpoint.exportMode
                })
            );
            initializedEndpoints.push(endpoint);
            logger.info(
                `Langfuse tracing endpoint initialized: name=${endpoint.name}, source=${endpoint.source}, baseUrl=${endpoint.baseUrl}`
            );
        } catch (err) {
            logger.warn(
                `Langfuse tracing endpoint initialization failed: name=${endpoint.name}, baseUrl=${endpoint.baseUrl}, error=${errorToMessage(err)}`
            );
        }
    }
    if (processors.length === 0) {
        activeConfig = undefined;
        activeProcessors = [];
        return undefined;
    }

    try {
        // 延迟加载用于打破 observation -> init -> instrumentation 的模块环。
        const { LangfuseAgentExecutionInstrumentation } = await import('./agent-execution.js');
        activeConfig = {
            ...config,
            endpoints: initializedEndpoints
        };
        activeProcessors = processors;
        registerProcessHooks();
        return {
            name: 'langfuse',
            spanProcessors: processors,
            acceptsSpan: isLangfuseSpan,
            bindTracerProvider: setLangfuseTracerProvider,
            agentExecutionInstrumentations: [new LangfuseAgentExecutionInstrumentation()],
            async shutdown(): Promise<void> {
                setLangfuseTracerProvider(null);
                activeConfig = undefined;
                activeProcessors = [];
            }
        };
    } catch (err) {
        await Promise.allSettled(processors.map((processor) => processor.shutdown()));
        activeConfig = undefined;
        activeProcessors = [];
        logger.warn(`Langfuse tracing initialization failed: ${errorToMessage(err)}`);
        return undefined;
    }
}

export function getActiveLangfuseConfig(): LangfuseRuntimeConfig | undefined {
    return activeConfig;
}

export async function flushLangfuseTelemetry(): Promise<void> {
    const results = await Promise.allSettled(activeProcessors.map((processor) => processor.forceFlush()));
    for (const result of results) {
        if (result.status === 'rejected') {
            logger.warn(`Langfuse tracing flush failed: ${errorToMessage(result.reason)}`);
        }
    }
}

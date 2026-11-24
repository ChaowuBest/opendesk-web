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

import os from 'node:os';
import { getAccountRuntime } from '../../../../account/factory.js';
import { getPlatform } from '../../../../../../platforms/base.js';
import { getOrCreateDeviceId } from '../../../../../utils/reporter.js';
import type { InteractionDeliveryRuntime } from '../../../../../aikernel/interaction/delivery.js';
import { createTuiHostCapabilities, type TuiHostCapabilitySource } from './tui-capabilities.js';
import { startMobileHostComposition, type MobileHostCompositionHandle } from '../host-composition.js';
import { createRegistrationRuntime } from '../../../remote-access/registration-runtime.js';
import { composeRegistrationConnection } from '../../../remote-access/connection-runtime.js';
import { logTuiRemoteDiagnostic } from './tui-diagnostics.js';

function diagnose(event: unknown): void {
    logTuiRemoteDiagnostic('network', event);
}

export async function prepareTuiNetwork(
    input: {
        capabilitySource: TuiHostCapabilitySource;
        interactionRuntime: InteractionDeliveryRuntime;
    },
    signal: AbortSignal
): Promise<(signal: AbortSignal) => Promise<MobileHostCompositionHandle>> {
    if (signal.aborted) throw signal.reason;
    // Only the standard Node interactive entry can reach this preparation boundary.
    const { createNodeNetworkBridge } = await import('../../../remote-access/node-network-bridge.js');
    if (signal.aborted) throw signal.reason;
    const deviceId = getOrCreateDeviceId();
    const account = getAccountRuntime().getService();
    const hostCapabilities = createTuiHostCapabilities(input.capabilitySource);
    const owner = { hostInstanceId: crypto.randomUUID(), generation: 1 };
    return async (startSignal) =>
        startMobileHostComposition({
            hostCapabilities,
            interactionRuntime: input.interactionRuntime,
            signal: startSignal,
            diagnose: (_scope, event) => diagnose(event),
            startNetwork: async ({ signal: networkSignal, openConnection }) => {
                const registration = createRegistrationRuntime({
                    hostType: 'cli',
                    deviceId,
                    name: os.hostname(),
                    signal: networkSignal,
                    getCredential: () => account.getCredential(),
                    subscribe: (listener) => account.subscribe(listener),
                    fetch: (url, init) => getPlatform().fetch(url, init),
                    diagnose
                });
                try {
                    return composeRegistrationConnection({
                        registration,
                        signal: networkSignal,
                        openConnection,
                        diagnose,
                        bridge: createNodeNetworkBridge({ owner, diagnose })
                    });
                } catch (error) {
                    await registration.close();
                    throw error;
                }
            }
        });
}

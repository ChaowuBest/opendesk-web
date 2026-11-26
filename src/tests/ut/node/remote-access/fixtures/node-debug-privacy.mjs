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

import { debug } from 'werift';
import { createNodeNetworkBridge } from '../../../../../main/applications/mobileaccess/remote-access/node-network-bridge.js';
import { logTuiRemoteDiagnostic } from '../../../../../main/applications/mobileaccess/acp/mobile/hosts/tui-diagnostics.js';
import { logger } from '../../../../../main/utils/logger.js';

const before = process.env.DEBUG;
const transport = await createNodeNetworkBridge({
    owner: { hostInstanceId: 'synthetic-host', generation: 1 }
}).create({
    attemptId: 'synthetic-attempt', signal: new AbortController().signal,
    iceServers: [{ urls: ['turn:127.0.0.1:9?transport=udp'],
        username: 'SYNTHETIC_TURN_USER', credential: 'SYNTHETIC_TURN_CREDENTIAL' }],
    candidate() {}
});
try {
    transport.instance.createDataChannel('acp', { ordered: true });
    await transport.instance.createOffer();
    const debugEnvironmentPreserved = process.env.DEBUG === before;
    // Programmatic enablement must not reopen the dependency's raw diagnostic sink.
    debug.enable('*');
    debug('werift:synthetic-private-probe')('SYNTHETIC_PRIVATE_SESSION');
    debug('packages/rtp/synthetic-private-probe')('SYNTHETIC_PRIVATE_SESSION');
    debug('opendesk:synthetic-public-probe')('SYNTHETIC_OTHER_DEBUG');
    logTuiRemoteDiagnostic('network', { code: 'attempt_expired', count: 1 });
    process.stdout.write(JSON.stringify({ debugEnvironmentPreserved }));
} finally {
    await transport.close();
    debug.enable(before ?? '');
    await new Promise((resolve) => { logger.once('finish', resolve); logger.end(); });
}

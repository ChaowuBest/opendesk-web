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

import * as acp from '@agentclientprotocol/sdk';
import { Readable } from 'node:stream';
import { OpenDeskAcpAgent } from './agent.js';
import { createAcpProtocolOutput } from './stdio.js';

export async function startAcpServer(): Promise<void> {
    const output = createAcpProtocolOutput();
    const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(output, input);
    const connection = new acp.AgentSideConnection((conn) => new OpenDeskAcpAgent(conn), stream);
    await connection.closed;
}

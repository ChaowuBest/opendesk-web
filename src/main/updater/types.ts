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

export interface UpdateRelease {
    version: string;
    installerUrl: string;
    installerName: string;
    size?: number;
    sha256?: string;
    notes?: string;
}

export type UpdateState =
    | { status: 'idle' }
    | { status: 'unsupported' }
    | { status: 'checking' }
    | { status: 'upToDate'; checkedAt: string }
    | { status: 'downloading'; version: string; receivedBytes: number; totalBytes?: number }
    | { status: 'ready'; version: string; installerPath: string; notes?: string; activeTaskCount: number }
    | { status: 'installing'; version: string }
    | { status: 'installed'; version: string; notes?: string; activeTaskCount: number }
    | { status: 'restarting'; version: string }
    | { status: 'error'; code: string; message: string };

export interface ReadyUpdateRecord {
    requestId: string;
    version: string;
    installerPath: string;
    sha256: string;
    notes?: string;
}

export interface UpdateServiceResponse {
    protocolVersion: number;
    requestId: string;
    status: string;
    code: string;
    targetVersion?: string;
    installerExitCode?: number;
    cleanupExitCode?: number;
    message?: string;
    updatedAtUtc: string;
}

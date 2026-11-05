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

export interface ExportRequest {
    readonly suggestedName: string;
    readonly mimeType: string;
    readonly extensions: readonly string[];
    readonly title?: string;
}

/** Host-owned document access. The id is opaque and must never be used as a filesystem path. */
export interface ExportDestination {
    readonly id: string;
    readonly displayName?: string;
}

export interface ExportReceipt {
    readonly displayName?: string;
}

export type ExportContent = string | Uint8Array;
export type ExportResult<Receipt extends ExportReceipt = ExportReceipt> =
    { canceled: true } | { canceled: false; receipt: Receipt };

export interface ExportDestinationHost<Receipt extends ExportReceipt = ExportReceipt> {
    selectDestination(request: ExportRequest): Promise<ExportDestination | null>;
    /** Stage content without claiming that the document provider has committed it. */
    write(destination: ExportDestination, content: ExportContent): Promise<void>;
    /** Resolve only after the selected destination confirms the write. Reject on provider failure. */
    commit(destination: ExportDestination): Promise<Receipt>;
    /** Idempotently release request-scoped tokens, grants, and staging resources. */
    release(destination: ExportDestination): Promise<void>;
}

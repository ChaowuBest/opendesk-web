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

export interface OfficeDocumentCommit {
    kind: 'word' | 'slides' | 'sheets';
    editorId: number;
    /** A real working-copy path; external document identifiers never go here. */
    localPath: string;
    /** Available for in-memory serializers; stream writers expose only the completed working copy. */
    bytes?: Uint8Array;
    intent: 'save' | 'save-as' | 'save-new';
}

export interface OfficeDocumentStorage {
    /**
     * Complete persistence before resolving. The editor retains its dirty state
     * and recovery data until this operation succeeds. Hosts with an external
     * provider own its commit and any failed-write recovery here.
     */
    commit(request: OfficeDocumentCommit, persistWorkingCopy: () => Promise<void>): Promise<void>;
}

/** Electron keeps the package's atomic writer, including its platform retry policy. */
export const localOfficeDocumentStorage: OfficeDocumentStorage = {
    async commit(_request, persistWorkingCopy) {
        await persistWorkingCopy();
    }
};

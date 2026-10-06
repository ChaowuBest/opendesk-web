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
 * Renderer 端由 preload.js 暴露的 API 类型定义
 */
declare module '*.css?raw' {
    const content: string;
    export default content;
}

declare module '*.yaml?raw' {
    const content: string;
    export default content;
}

declare module '*.jsonl?raw' {
    const content: string;
    export default content;
}

declare global {
    interface Window {
        officeHostAPI: {
            prepare: (kind: 'slides' | 'word' | 'sheets') => Promise<boolean>;
            requestClose: (kind: 'slides' | 'word' | 'sheets', webContentsId: number) => Promise<boolean>;
            bindOfficeTask: (
                kind: 'slides' | 'word' | 'sheets',
                taskId: string,
                filePath: string,
                webContentsId: number
            ) => Promise<boolean>;
            onOpenOfficeTaskFile: (
                callback: (request: {
                    requestId: string;
                    kind: 'slides' | 'word' | 'sheets';
                    taskId: string;
                    filePath: string;
                }) => void
            ) => () => void;
            reportOpenOfficeTaskFileResult: (requestId: string, status: 'not_opened' | 'failed') => void;
        };
        settingErrorAPI: {
            onSettingLoadError: (callback: (message: string) => void) => void;
            offSettingLoadError: (callback: (message: string) => void) => void;
        };
        updateAPI?: {
            getState: () => Promise<
                | { status: 'idle' | 'checking' | 'unsupported' }
                | { status: 'upToDate'; checkedAt: string }
                | { status: 'downloading'; version: string; receivedBytes: number; totalBytes?: number }
                | { status: 'ready'; version: string; notes?: string; activeTaskCount: number }
                | { status: 'installing'; version: string }
                | { status: 'installed'; version: string; notes?: string; activeTaskCount: number }
                | { status: 'restarting'; version: string }
                | { status: 'error'; code: string; message: string }
            >;
            check: () => Promise<unknown>;
            restart: () => Promise<boolean>;
            onStateChanged: (callback: (state: Record<string, unknown>) => void) => () => void;
        };
        settingAPI: {
            listShells: () => Promise<import('../common/shells.js').SupportedShell[]>;
            loadSettingObject: () => Promise<Record<string, unknown> & { locale?: string; resolved_locale?: string }>;
            saveSettingObject: (
                settingObject: unknown
            ) => Promise<(Record<string, unknown> & { locale?: string; resolved_locale?: string }) | undefined>;
            onSettingChanged?: (
                callback: (
                    settingObject: Record<string, unknown> & { locale?: string; resolved_locale?: string }
                ) => void
            ) => () => void;
        };
        trashAPI: {
            search: (options: {
                scope: 'task' | 'global';
                taskId?: string;
                keyword?: string;
                offset?: number;
                limit?: number;
            }) => Promise<{
                total: number;
                entries: Array<{
                    uuid: string;
                    original_path: string;
                    size: number;
                    deleted_at: string;
                    task_id: string;
                }>;
            }>;
            restore: (
                taskId: string,
                uuid: string,
                overwrite: boolean
            ) => Promise<{
                restored: boolean;
                exists?: boolean;
                identical?: boolean;
                target_mtime?: number;
                target?: string;
                message?: string;
            }>;
            openEntry: (taskId: string, uuid: string) => Promise<{ path: string }>;
            getTaskContext: (taskId: string) => Promise<{
                task_id: string;
                task_name: string;
                last_user_message: string;
            } | null>;
        };
    }
}

export {};

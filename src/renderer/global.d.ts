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
        slidesHostAPI: {
            prepare: () => Promise<boolean>;
            requestClose: (webContentsId: number) => Promise<boolean>;
        };
        settingErrorAPI: {
            onSettingLoadError: (callback: (message: string) => void) => void;
            offSettingLoadError: (callback: (message: string) => void) => void;
        };
        settingAPI: {
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
    }
}

export {};

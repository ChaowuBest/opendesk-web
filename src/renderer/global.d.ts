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
    /**
     * 保存设置后「已落盘、但未能立即生效」的步骤。
     * 与主进程 main/utils/setting-side-effects.ts 的 SettingSideEffectFailure 对应
     * （renderer 不能直接引用主进程模块，故此处单独声明）；
     * label 是稳定的步骤 id，renderer 据此映射本地化文案；message 是原始异常信息，仅用于日志诊断。
     */
    interface SettingSideEffectFailure {
        label: string;
        message: string;
    }

    /**
     * loadSettingObject / saveSettingObject / onSettingChanged 共用的持久化设置对象形状。
     * renderer 只声明实际消费的字段（其余仍可经 Record 索引访问），嵌套形状与主进程
     * Setting schema 对齐；所有字段都可能缺省（旧配置未写过时），调用方需按默认值兜底。
     */
    interface LoadedSettingObject extends Record<string, unknown> {
        locale?: string;
        resolved_locale?: string;
        default_model?: string;
        gui_config?: {
            font_preset?: string;
            /** 快速截图开关（HarmonyOS / Windows）；缺省视为开启（仅 renderer .js 消费，此处为契约文档化）。 */
            quick_capture_enabled?: boolean;
        };
        debug?: {
            experimental_features?: import('./utils/application-visibility.js').ExperimentalFeatureSettings;
        };
        providers?: Array<{
            name: string;
            provider_type?: 'openai' | 'anthropic';
            base_url: string;
            api_key: string;
            no_proxy?: boolean;
            no_ssl?: boolean;
        }>;
        models?: Array<{
            alias: string;
            provider_name?: string;
            model_name: string;
            model_type?: 'chat' | 'embedding';
            reasoning_effort?: string;
        }>;
    }

    interface Window {
        /** 由 preload 注入的平台信息。 */
        systemInfo?: {
            /** 是否运行在 HarmonyOS（process.platform === 'openharmony'）。 */
            isOpenHarmony?: boolean;
            /** 是否运行在 Windows（process.platform === 'win32'）。 */
            isWindows?: boolean;
        };
        /** preload 剪贴板桥：沙箱渲染器经主进程 IPC 读写剪贴板（自绘菜单粘贴等）。 */
        childFrameClipboard?: {
            readText: () => Promise<string>;
            writeText: (text: string) => Promise<void>;
        };
        terminalAPI: {
            listProfiles: () => Promise<
                Array<{ id: string; kind: 'powershell' | 'bash' | 'zsh' | 'cmd'; path: string }>
            >;
            create: (options: {
                profileId: string;
                cwd?: string;
                taskId?: string;
                cols?: number;
                rows?: number;
            }) => Promise<{
                sessionId: string;
                profile: { id: string; kind: 'powershell' | 'bash' | 'zsh' | 'cmd'; path: string };
                cwd: string;
                backend: 'pty' | 'pipe';
            }>;
            write: (sessionId: string, data: string) => Promise<void>;
            start: (sessionId: string) => Promise<void>;
            acknowledge: (sessionId: string, count: number) => Promise<void>;
            resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
            close: (sessionId: string) => Promise<void>;
            onData: (callback: (event: { sessionId: string; data: string }) => void) => () => void;
            onExit: (callback: (event: { sessionId: string; exitCode: number; signal?: number }) => void) => () => void;
        };
        officeHostAPI: {
            prepare: (kind: import('../common/officeWebview.js').OfficeEditorKind) => Promise<boolean>;
            requestClose: (
                kind: import('../common/officeWebview.js').OfficeEditorKind,
                webContentsId: number
            ) => Promise<boolean>;
            refreshFile: (webContentsId: number, filePath: string) => Promise<void>;
            bindOfficeTask: (
                kind: import('../common/officeWebview.js').OfficeEditorKind,
                taskId: string,
                filePath: string,
                webContentsId: number
            ) => Promise<boolean>;
            onOpenOfficeTaskFile: (
                callback: (request: {
                    requestId: string;
                    kind: import('../common/officeWebview.js').OfficeEditorKind;
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
        /** preload 注入的语言包 API：快照由 preload 缓存，供翻译器同步读取 */
        localeAPI?: {
            /** 当前语言包快照；首次拉取完成前或不可达时为 null */
            getLocalePacks: () => import('./locale.js').RendererLocalePackSnapshot | null;
            /** 订阅语言包变更（含首次拉取完成），返回取消函数 */
            onLocalePacksChanged: (
                callback: (snapshot: import('./locale.js').RendererLocalePackSnapshot | null) => void
            ) => () => void;
        };
        settingAPI: {
            listShells: () => Promise<import('../common/shells.js').SupportedShell[]>;
            loadSettingObject: () => Promise<LoadedSettingObject>;
            saveSettingObject: (settingObject: unknown) => Promise<LoadedSettingObject | undefined>;
            /** 同 saveSettingObject，但额外带回本次保存未能立即生效的步骤（错误信息随调用返回，不跨调用共享） */
            saveSettingObjectDetailed: (settingObject: unknown) => Promise<{
                data: LoadedSettingObject | undefined;
                sideEffectFailures: SettingSideEffectFailure[];
            }>;
            onSettingChanged?: (callback: (settingObject: LoadedSettingObject) => void) => () => void;
            submitFeedback: (submission: unknown) => Promise<any>;
            getProviderTemplates: () => Promise<
                Array<{ name: string; displayName: string; base_url: string; provider_type?: 'openai' | 'anthropic' }>
            >;
            fetchProviderModels: (params: {
                base_url: string;
                api_key: string;
                provider_type?: 'openai' | 'anthropic';
                no_proxy?: boolean;
                no_ssl?: boolean;
            }) => Promise<string[]>;
            verifyModel: (params: {
                base_url: string;
                api_key: string;
                provider_type?: 'openai' | 'anthropic';
                model_name: string;
                model_type?: 'chat' | 'embedding';
                custom_headers?: Record<string, string>;
                no_proxy?: boolean;
                no_ssl?: boolean;
            }) => Promise<boolean>;
        };
        native?: {
            call: (method: string, ...args: unknown[]) => Promise<any>;
        };
        taskManagerAPI: {
            createTask: (options?: unknown) => Promise<any>;
            removeTask: (taskId: string) => Promise<any>;
            releaseTaskMemory: (taskId: string) => Promise<any>;
            forkTask: (taskId: string, upToMessageId?: string) => Promise<any>;
            compactTask: (taskId: string) => Promise<any>;
            renameTask: (taskId: string, newName: string) => Promise<any>;
            submitMessage: (taskId: string, request: unknown) => Promise<any>;
            attachToolset: (
                taskId: string,
                toolset: unknown,
                callback?: (toolName: string, args: unknown) => unknown
            ) => Promise<any>;
            setSystemPrompt: (taskId: string, prompt: unknown) => Promise<any>;
            getTaskList: () => Promise<any[]>;
            getFullTask: (taskId: string) => Promise<any>;
            getContextDiagnostics: (taskId: string) => Promise<any>;
            subscribeTaskUpdate: (taskId: string, callback: (progress: unknown) => void) => Promise<any>;
            unsubscribeTaskUpdate: (taskId: string, callback: (progress: unknown) => void) => Promise<any>;
        };
        applicationAPI: {
            setApplicationBundleName: (bundleName: string) => Promise<void>;
            call: (methodName: string, ...args: unknown[]) => Promise<any>;
            callMainWorld: (methodName: string, ...args: unknown[]) => Promise<any>;
            streamCall: (methodName: string, callback: (chunk: unknown) => void, ...args: unknown[]) => Promise<void>;
            streamCallMainWorld: (
                methodName: string,
                callback: (chunk: unknown) => void,
                ...args: unknown[]
            ) => Promise<void>;
            /** 返回只退订该 callback 的函数；同通道其他订阅者不受影响 */
            subscribe: (eventName: string, callback: (...args: unknown[]) => void) => Promise<() => void>;
            /**
             * 移除该事件在本 frame 登记的全部订阅。
             * 只退订自己请用 subscribe 返回值：contextBridge 会重新包装跨上下文函数，
             * 按 callback 引用匹配并不可靠。
             */
            unsubscribe: (eventName: string) => Promise<void>;
        };
        applicationRegistryAPI?: {
            call: (bundleName: string, methodName: string, ...args: unknown[]) => Promise<any>;
            callMainWorld: (bundleName: string, methodName: string, ...args: unknown[]) => Promise<any>;
            streamCall: (
                bundleName: string,
                methodName: string,
                callback: (chunk: unknown) => void,
                ...args: unknown[]
            ) => Promise<any>;
            streamCallMainWorld: (
                bundleName: string,
                methodName: string,
                callback: (chunk: unknown) => void,
                ...args: unknown[]
            ) => Promise<any>;
            subscribeEvent: (
                bundleName: string,
                eventName: string,
                callback: (...args: unknown[]) => void
            ) => Promise<() => void>;
            ensureFullyLoaded: () => Promise<void>;
            ensureApplicationLoaded: (bundleName: string) => Promise<void>;
            getApplicationGUIConfig: (bundleName: string) => Promise<any>;
            getApplicationList: () => Promise<any>;
        };
        fsAPI: {
            searchFilesByKeyword: (keyword: string) => Promise<any>;
            searchFilesByKeywordInPath: (keyword: string, basePath: string) => Promise<any>;
            searchIndexedFiles: (query: string, options?: unknown) => Promise<any>;
            openPath: (filePath: string) => Promise<void>;
            showItemInFolder: (filePath: string) => Promise<void>;
            openTrash: () => Promise<void>;
            selectFile: () => Promise<string[]>;
            selectDirectory: () => Promise<string | null>;
            listDirectory: (
                dirPath: string,
                options?: { includeFiles?: boolean; extensions?: string[]; showHidden?: boolean }
            ) => Promise<any>;
            readFile: (filePath: string) => Promise<any>;
            getFileSize: (filePath: string) => Promise<number>;
            watchFile: (
                filePath: string,
                callback: (change: { path: string; type: 'changed' | 'missing' }) => void
            ) => Promise<() => void>;
            readTextFile: (filePath: string, maxBytes?: number) => Promise<any>;
            writeTextFile: (filePath: string, content: string) => Promise<any>;
            fileExists: (filePath: string) => Promise<any>;
            getPathType: (filePath: string) => Promise<any>;
            getFilePath: (...args: unknown[]) => Promise<any>;
            resolveFilePath: (filePath: string) => Promise<string>;
            saveFile: (...args: unknown[]) => Promise<any>;
            trashItem: (...args: unknown[]) => Promise<any>;
            word: (...args: unknown[]) => Promise<any>;
            sheets: (...args: unknown[]) => Promise<any>;
            slides: (...args: unknown[]) => Promise<any>;
        };
        workspaceAPI?: {
            getEffectiveWorkspace: () => Promise<string | null>;
            pickDirectoryDialog?: () => Promise<string | null>;
            listDirectory: (
                path: string,
                options?: { includeFiles?: boolean; extensions?: string[]; showHidden?: boolean }
            ) => Promise<any>;
        };
        aiBarAPI: {
            submitRequest: (request: string) => Promise<void>;
            submitRequestInNewTask: (request: string) => Promise<void>;
        };
        notificationAPI?: {
            sendNotification: (...args: unknown[]) => Promise<any>;
            /** 返回只退订该 callback 的函数 */
            subscribeNotification: (callback: (...args: unknown[]) => void) => Promise<() => void>;
        };
        /** 内嵌 office 套件（@bitclub.ai/opendesk-office）preload 暴露的 Word 桌面桥接 */
        wordDesktop?: Record<string, (...args: any[]) => any>;
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

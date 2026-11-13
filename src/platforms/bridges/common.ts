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

export interface PeekResult {
    content: string;
    finished: boolean;
}

export interface SpeechKit {
    available(): Promise<boolean>;
    initialize(locale?: string | null): Promise<void>;
    start(): Promise<void>;
    peek(): Promise<PeekResult>;
    stop(): Promise<string>;
    release(): Promise<void>;
}

export interface OcrKit {
    available(): Promise<boolean>;
}

// ── Huawei Account Kit ──────────────────────────────────────────────────────

export interface HuaweiLoginResult {
    status: boolean;
    authCode: string;
    unionId: string;
    openId: string;
    idToken: string;
    anonymousPhone: string;
}

export interface HuaweiAccountKit {
    available(): Promise<boolean>;
    startLogin(): Promise<void>;
    restoreLogin(): Promise<void>;
    peekLogin(): Promise<HuaweiLoginResult | null>;
    closeLogin(): Promise<void>;
}

export type StartupMode = 'toggle' | 'system-settings';

export interface StartupState {
    /** Status-query support; system settings delegation can remain available independently. */
    supported: boolean;
    /** null means the operating system's current state could not be determined. */
    enabled: boolean | null;
    mode: StartupMode;
    reason?: 'unsupported' | 'unavailable';
}

/** Startup is owned by the OS; delegating a change does not prove it took effect. */
export interface StartupKit {
    /** Toggle-capable platforms require a boolean; system settings platforms accept no argument. */
    delegateSetting(enabled?: boolean): Promise<void>;
    getState(): Promise<StartupState>;
}

export class NaiveStartupKit implements StartupKit {
    async getState(): Promise<StartupState> {
        return { supported: false, enabled: null, mode: 'toggle', reason: 'unsupported' };
    }

    async delegateSetting(_enabled?: boolean): Promise<void> {
        throw new Error('Startup is unavailable');
    }
}

/** Keep capability metadata available even when a native status query fails. */
export function guardStartupKit(kit: StartupKit, mode: StartupMode): StartupKit {
    return {
        async getState() {
            try {
                return await kit.getState();
            } catch (error) {
                console.error('Failed to read native startup state', error);
                return { supported: true, enabled: null, mode, reason: 'unavailable' };
            }
        },
        async delegateSetting(enabled) {
            if (mode === 'toggle' ? typeof enabled !== 'boolean' : enabled !== undefined) {
                throw new TypeError('Invalid startup delegation argument');
            }
            await kit.delegateSetting(enabled);
        }
    };
}

// ── QuickCapture (Alt+Space 全局热键截图，HarmonyOS / Windows) ───────────────

export interface QuickCaptureState {
    supported: boolean;
    enabled: boolean;
}

/** 开关状态不持久化：进程重启后恢复默认开启，前端自行决定是否记忆展示态。 */
export interface QuickCaptureKit {
    getState(): Promise<QuickCaptureState>;
    setEnabled(enabled: boolean): Promise<QuickCaptureState>;
    /**
     * 取出（并清空）一条待处理的快速截图。
     * 主进程负责把缓存文件读成 Data URL 并删除源文件；无待处理时返回 null。
     */
    takePendingCapture(): Promise<QuickCapturePendingCapture | null>;
    /**
     * 可选：由主进程的全局热键回调转发触发（目前仅 Windows 由 main.ts 的
     * globalShortcut 回调调用；HarmonyOS 的热键注册在 ArkTS 侧，不实现该方法）。
     */
    triggerFromHotkey?(): void;
}

/** 一条待处理的快速截图（已编码为 Data URL，可直接用于附件展示）。 */
export interface QuickCapturePendingCapture {
    dataUrl: string;
}

/**
 * 截图已交接给主窗口时由 kit 在 app 上 emit、由 main.ts 监听后把主窗口带到前台的事件名。
 * 两侧必须一致，故只在 common 里定义一次。
 */
export const QUICK_CAPTURE_BRING_MAIN_TO_FRONT_EVENT = 'opendesk:quick-capture:bring-main-to-front';

export class NaiveQuickCaptureKit implements QuickCaptureKit {
    async getState(): Promise<QuickCaptureState> {
        return { supported: false, enabled: false };
    }

    async setEnabled(_enabled: boolean): Promise<QuickCaptureState> {
        throw new Error('QuickCapture is not available on this platform');
    }

    async takePendingCapture(): Promise<QuickCapturePendingCapture | null> {
        return null;
    }
}

export interface NativeCalendar {
    id: string;
    name: string;
    accountName?: string;
    canWrite: boolean;
    visible?: boolean;
    primary?: boolean;
}

/** Native event identifiers are opaque to business code; times are epoch milliseconds. */
export interface CalendarEvent {
    uid: string;
    calendarId: string;
    subject: string;
    startTime: number;
    endTime: number;
    location: string;
    isAllDay: boolean;
    isCancelled: boolean;
    type: string;
    canWrite: boolean;
    recurring: boolean;
}

export type CalendarEventInput = Pick<CalendarEvent, 'subject' | 'startTime' | 'endTime'> &
    Partial<Pick<CalendarEvent, 'location' | 'isAllDay' | 'type'>>;
export type CalendarEventUpdates = Partial<CalendarEventInput>;

export interface CalendarKitState {
    supported: boolean;
    readGranted: boolean;
    writeGranted: boolean;
    calendars: NativeCalendar[];
    revision?: string | number;
}

export interface CalendarKitChange {
    revision?: string | number;
}

/** OS calendar capabilities only; local storage, configuration and reminders belong to the application. */
export interface CalendarKit {
    getState(): Promise<CalendarKitState>;
    /** Requests permission UI; completion is observed through state and change notifications. */
    requestAccess(): Promise<void>;
    listEvents(startTime: number, endTime: number): Promise<CalendarEvent[]>;
    addEvent(calendarId: string, item: CalendarEventInput): Promise<CalendarEvent>;
    updateEvent(uid: string, updates: CalendarEventUpdates): Promise<CalendarEvent>;
    deleteEvent(uid: string): Promise<{ deleted: boolean; uid: string }>;
    /** Recognizes identities belonging to this provider without exposing their encoding. */
    ownsEvent(uid: string): boolean;
    /** Returns an idempotent disposer that releases this listener alone. */
    onDidChange(listener: (change: CalendarKitChange) => void): () => void;
}

export class NaiveCalendarKit implements CalendarKit {
    async getState(): Promise<CalendarKitState> {
        return { supported: false, readGranted: false, writeGranted: false, calendars: [] };
    }

    ownsEvent(_uid: string): boolean {
        return false;
    }

    onDidChange(_listener: (change: CalendarKitChange) => void): () => void {
        return () => undefined;
    }

    private unavailable(): never {
        // Internal capability error; calendar services localize it for the user.
        throw Object.assign(new Error('Native calendar is unavailable'), { code: 'CALENDAR_UNAVAILABLE' });
    }

    async requestAccess(): Promise<void> {
        this.unavailable();
    }

    async listEvents(_startTime: number, _endTime: number): Promise<CalendarEvent[]> {
        this.unavailable();
    }

    async addEvent(_calendarId: string, _item: CalendarEventInput): Promise<CalendarEvent> {
        this.unavailable();
    }

    async updateEvent(_uid: string, _updates: CalendarEventUpdates): Promise<CalendarEvent> {
        this.unavailable();
    }

    async deleteEvent(_uid: string): Promise<{ deleted: boolean; uid: string }> {
        this.unavailable();
    }
}

export interface SandboxKitState {
    supported: boolean;
    ready: boolean;
    reason?: 'unsupported' | 'unavailable' | 'initializing';
}

export interface NativeSandboxRequest {
    shellPath: string;
    shellArgs: string[];
    cwd: string;
    policyPath: string;
    endpoint: string;
    logPath: string;
    readOnly: boolean;
    deleteToTrash?: boolean;
    trashDir?: string;
    trashExcludeDirs?: string[];
}

export interface NativeSandboxLaunch {
    file: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    detached?: boolean;
    runtimePaths?: { readExecute: string[]; writable: string[] };
    cleanup?: () => void | Promise<void>;
}

/** Native launch mechanics only; shared services own task policies, approvals and process execution. */
export interface SandboxKit {
    getState(): Promise<SandboxKitState>;
    prepare(request: NativeSandboxRequest): Promise<NativeSandboxLaunch>;
}

export class NaiveSandboxKit implements SandboxKit {
    async getState(): Promise<SandboxKitState> {
        return { supported: false, ready: false, reason: 'unsupported' };
    }

    async prepare(_request: NativeSandboxRequest): Promise<NativeSandboxLaunch> {
        // Internal capability error; terminal services localize it for the user.
        throw Object.assign(new Error('Native shell sandbox is unavailable'), { code: 'SANDBOX_UNAVAILABLE' });
    }
}

/**
 * 原生平台功能桥接的接口定义。这个桥接设计用于封装不同操作系统和硬件平台的差异。
 */
export interface NativeBridge {
    /**
     * 当前原生平台的系统平台标识，该表示应该始终与 Node.js 的 process.platform 保持一致，以便于平台特定的逻辑分支处理
     */
    getPlatform(): Promise<string>;

    /**
     * 当前原生平台的变体标识，用于区分同一系统平台下的不同设备类型或系统版本。
     * 例如鸿蒙PC等官方系统支持原生的语音识别等端侧模型能力，但第三方的OpenHarmony开发板则未必
     * 支持，我们通过 variant 来区分不同的设备类型或系统版本。
     */
    getVariant(): Promise<string>;

    getStartupKit(): Promise<StartupKit>;
    getSpeechKit(): Promise<SpeechKit>;
    getOcrKit(): Promise<OcrKit>;
    getDatabaseKit(): Promise<DatabaseKit>;
    getHuaweiAccountKit(): Promise<HuaweiAccountKit>;
    getQuickCaptureKit(): Promise<QuickCaptureKit>;
    getCalendarKit(): Promise<CalendarKit>;
    getSandboxKit(): Promise<SandboxKit>;
}

export class NaiveSpeechKit implements SpeechKit {
    async available(): Promise<boolean> {
        return false;
    }

    async initialize(_locale?: string | null): Promise<void> {
        throw new Error('NaiveSpeechKit does not support initialize');
    }

    async start(): Promise<void> {
        throw new Error('NaiveSpeechKit does not support start');
    }

    async peek(): Promise<PeekResult> {
        throw new Error('NaiveSpeechKit does not support peek');
    }

    async stop(): Promise<string> {
        throw new Error('NaiveSpeechKit does not support stop');
    }

    async release(): Promise<void> {
        throw new Error('NaiveSpeechKit does not support release');
    }
}

export class NaiveOcrKit implements OcrKit {
    async available(): Promise<boolean> {
        return false;
    }
}

export class NaiveHuaweiAccountKit implements HuaweiAccountKit {
    async available(): Promise<boolean> {
        return false;
    }

    private unavailable(): never {
        throw new Error('HuaweiAccountKit not available on this platform');
    }

    async startLogin(): Promise<void> {
        this.unavailable();
    }

    async restoreLogin(): Promise<void> {
        this.unavailable();
    }

    async peekLogin(): Promise<HuaweiLoginResult | null> {
        this.unavailable();
    }

    async closeLogin(): Promise<void> {
        this.unavailable();
    }
}

export class NaiveNativeBridge implements NativeBridge {
    constructor(private readonly startupKit: StartupKit = new NaiveStartupKit()) {}

    async getStartupKit(): Promise<StartupKit> {
        return this.startupKit;
    }

    _speechKit: SpeechKit = new NaiveSpeechKit();
    _ocrKit: OcrKit = new NaiveOcrKit();
    _databaseKit: DatabaseKit = new NaiveDatabaseKit();
    _huaweiAccountKit: HuaweiAccountKit = new NaiveHuaweiAccountKit();
    _quickCaptureKit: QuickCaptureKit = new NaiveQuickCaptureKit();
    private readonly fallbackCalendarKit: CalendarKit = new NaiveCalendarKit();
    private readonly fallbackSandboxKit: SandboxKit = new NaiveSandboxKit();

    async getPlatform(): Promise<string> {
        return process.platform;
    }

    async getVariant(): Promise<string> {
        return 'naive';
    }

    async getSpeechKit(): Promise<SpeechKit> {
        return this._speechKit;
    }

    async getOcrKit(): Promise<OcrKit> {
        return this._ocrKit;
    }

    async getDatabaseKit(): Promise<DatabaseKit> {
        return this._databaseKit;
    }

    async getHuaweiAccountKit(): Promise<HuaweiAccountKit> {
        return this._huaweiAccountKit;
    }

    async getQuickCaptureKit(): Promise<QuickCaptureKit> {
        return this._quickCaptureKit;
    }

    async getCalendarKit(): Promise<CalendarKit> {
        return this.fallbackCalendarKit;
    }

    async getSandboxKit(): Promise<SandboxKit> {
        return this.fallbackSandboxKit;
    }
}

export type ArkDataValueType = { t: 'scalar'; v: number | string | boolean | null } | { t: 'vector'; v: number[] };

export type ArkDataRow = Record<string, number | string | boolean | null | number[]>;

export interface ArkDataExecResult {
    affectedRows: number | null;
}

export interface ArkDataTxHandle {
    readonly id: string;
}

export interface ArkDataTransactionOptions {
    /** Use one transaction API per store. Migrate all users of a store together. */
    mode: 'read' | 'write';
}

export interface ArkDataBM25Request {
    deadline: number;
    kind: 'allowlist' | 'search';
    searchId?: string;
    batchIndex?: number;
    batchCount?: number;
    itemIds?: string[];
    field?: string;
    terms?: string[];
    topK?: number;
    pageSize?: number;
    collect?: boolean;
}
export interface ArkDataBM25Result {
    uploaded?: boolean;
    hits?: Array<{ item_id: string; field: string; subKey: string; score: number }>;
    diagnostics?: {
        strategy: 'exact_in';
        totalTargetRows: number;
        exactCandidateCount: number;
        exactBatchSize: number;
        exactBatchCount: number;
    };
}
export interface ArkDataOpenStoreOptions {
    /** Stable identity of one acquisition; reuse it when a response times out. */
    sessionId?: string;
    path?: string;
    vector?: boolean;
}

export interface ArkDataCloseStoreOptions {
    /** Release the matching acquisition, never a later holder of the same store. */
    sessionId?: string;
    force?: boolean;
}

export interface ArkDataExecOptions {
    txId?: string;
}

export interface ArkDataExecManyOptions extends ArkDataExecOptions {
    onProgress?: (done: number, total: number) => void;
}

export interface ArkDataBatchOptions extends ArkDataExecManyOptions {
    maxRows?: number;
    maxBytes?: number;
}

const DEFAULT_ARKDATA_BATCH_MAX_ROWS = 1000;
const DEFAULT_ARKDATA_BATCH_MAX_BYTES = 7 * 1024 * 1024;

function jsonByteLength(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export async function executePreparedManyBatchedWith(
    executeBatch: (rows: ArkDataValueType[][], opts?: ArkDataExecManyOptions) => Promise<ArkDataExecResult>,
    rows: ArkDataValueType[][],
    opts: ArkDataBatchOptions = {}
): Promise<ArkDataExecResult> {
    if (rows.length === 0) return { affectedRows: 0 };

    const maxRows = opts.maxRows ?? DEFAULT_ARKDATA_BATCH_MAX_ROWS;
    const maxBytes = opts.maxBytes ?? DEFAULT_ARKDATA_BATCH_MAX_BYTES;
    if (!Number.isSafeInteger(maxRows) || maxRows <= 0) {
        throw new Error(`ArkDataBatchedError: invalid maxRows=${String(maxRows)}`);
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 2) {
        throw new Error(`ArkDataBatchedError: invalid maxBytes=${String(maxBytes)}`);
    }

    let affectedRows = 0;
    let affectedRowsUnknown = false;
    let completed = 0;
    let batch: ArkDataValueType[][] = [];
    let batchBytes = 2;
    const { maxRows: _maxRows, maxBytes: _maxBytes, onProgress, ...execOpts } = opts;

    async function flush(): Promise<void> {
        if (batch.length === 0) return;
        const completedBefore = completed;
        const currentBatch = batch;
        batch = [];
        batchBytes = 2;
        const result = await executeBatch(currentBatch, {
            ...execOpts,
            onProgress: onProgress ? (done, _total) => onProgress(completedBefore + done, rows.length) : undefined
        });
        if (typeof result.affectedRows === 'number') {
            affectedRows += result.affectedRows;
        } else {
            affectedRowsUnknown = true;
        }
        completed += currentBatch.length;
        onProgress?.(completed, rows.length);
    }

    for (const row of rows) {
        const rowBytes = jsonByteLength(row);
        if (rowBytes > maxBytes) {
            throw new Error(
                `ArkDataBatchedError: single row exceeds payload limit (rowBytes=${rowBytes}, limit=${maxBytes})`
            );
        }
        const separatorBytes = batch.length === 0 ? 0 : 1;
        if (batch.length >= maxRows || batchBytes + separatorBytes + rowBytes > maxBytes) {
            await flush();
        }
        batch.push(row);
        batchBytes += (batch.length === 1 ? 0 : 1) + rowBytes;
    }
    await flush();

    return { affectedRows: affectedRowsUnknown ? null : affectedRows };
}

export interface DatabaseKit {
    bm25Query(storeId: string, request: ArkDataBM25Request, txId: string): Promise<ArkDataBM25Result>;
    available(): Promise<boolean>;

    execSql(storeId: string, sql: string): Promise<void>;
    execSqlParams(storeId: string, sql: string, params: ArkDataValueType[]): Promise<void>;
    querySqlShort(storeId: string, sql: string): Promise<ArkDataRow[]>;

    deleteStore(storeId: string, opts?: ArkDataOpenStoreOptions): Promise<void>;
    openStore(storeId: string, opts?: ArkDataOpenStoreOptions): Promise<void>;
    closeStore(storeId: string, opts?: ArkDataCloseStoreOptions): Promise<void>;

    executePrepared(
        storeId: string,
        sql: string,
        params: ArkDataValueType[],
        opts?: ArkDataExecOptions
    ): Promise<ArkDataExecResult>;
    executePreparedMany(
        storeId: string,
        sql: string,
        rows: ArkDataValueType[][],
        opts?: ArkDataExecManyOptions
    ): Promise<ArkDataExecResult>;
    executePreparedManyBatched(
        storeId: string,
        sql: string,
        rows: ArkDataValueType[][],
        opts?: ArkDataBatchOptions
    ): Promise<ArkDataExecResult>;
    queryPrepared(
        storeId: string,
        sql: string,
        params: ArkDataValueType[],
        opts?: ArkDataExecOptions
    ): Promise<ArkDataRow[]>;

    beginTransaction(storeId: string, opts?: ArkDataTransactionOptions): Promise<ArkDataTxHandle>;
    commitTransaction(storeId: string, tx: ArkDataTxHandle): Promise<void>;
    rollbackTransaction(storeId: string, tx: ArkDataTxHandle): Promise<void>;

    transaction<T>(storeId: string, fn: (tx: ArkDataTxHandle) => Promise<T>): Promise<T>;
}

export class ArkDataBridgeError extends Error {
    constructor(
        public readonly code: string,
        public readonly category: 'required' | 'diagnostic' | 'bridge',
        message: string,
        public readonly details?: unknown,
        options?: ErrorOptions | unknown
    ) {
        const errorOptions = options instanceof Error ? { cause: options } : options;
        super(message || code, errorOptions as ErrorOptions | undefined);
        this.name = 'ArkDataBridgeError';
    }
}

export class NaiveDatabaseKit implements DatabaseKit {
    async bm25Query(): Promise<ArkDataBM25Result> {
        return this.unavailable();
    }

    async available(): Promise<boolean> {
        return false;
    }

    private unavailable(): never {
        throw new Error('DatabaseKit not available on this platform');
    }

    async execSql(): Promise<void> {
        this.unavailable();
    }

    async execSqlParams(): Promise<void> {
        this.unavailable();
    }

    async querySqlShort(): Promise<ArkDataRow[]> {
        this.unavailable();
    }

    async deleteStore(): Promise<void> {
        this.unavailable();
    }

    async openStore(): Promise<void> {
        this.unavailable();
    }

    async closeStore(): Promise<void> {
        this.unavailable();
    }

    async executePrepared(): Promise<ArkDataExecResult> {
        this.unavailable();
    }

    async executePreparedMany(): Promise<ArkDataExecResult> {
        this.unavailable();
    }

    async executePreparedManyBatched(): Promise<ArkDataExecResult> {
        this.unavailable();
    }

    async queryPrepared(): Promise<ArkDataRow[]> {
        this.unavailable();
    }

    async beginTransaction(): Promise<ArkDataTxHandle> {
        this.unavailable();
    }

    async commitTransaction(): Promise<void> {
        this.unavailable();
    }

    async rollbackTransaction(): Promise<void> {
        this.unavailable();
    }

    async transaction<T>(): Promise<T> {
        this.unavailable();
    }
}

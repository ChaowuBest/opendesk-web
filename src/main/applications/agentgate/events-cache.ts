/**
 * AgentGate Events Cache — 在主进程中缓存 AgentGate 的拦截/放行事件，
 * 并通过回调定期推送给渲染进程，供浮窗组件显示。
 *
 * 工作原理:
 *   1. 从 AgentGateBridge 获取 AgentGate 端口
 *   2. 每 2 秒 poll http://127.0.0.1:{gatePort}/api/v1/tool_calls?limit=50
 *   3. 缓存最近 50 条事件
 *   4. 通过 pushCallback 回调推送给渲染进程（由 main.ts 调用者提供）
 *   5. 仅在 floatingWindowEnabled=true 且 AgentGate 运行时启动轮询
 *
 * 注意：此模块可能被打包进 worker chunk，因此不能直接引入 electron 模块。
 * 推送 IPC 的工作由 main.ts 中的调用者通过 pushCallback 完成。
 */

import { AgentGateBridge } from '../../services/agent-gate-bridge';
import { Setting } from '../../utils/setting';

const POLL_INTERVAL_MS = 2000;
const MAX_EVENTS = 50;

interface AgentGateEvent {
    id: string;
    called_at: string;
    agent_type: string;
    session_id: string;
    command: string;
    action_detail: string;
    decision: 'Allow' | 'Deny';
    risk_level: 'critical' | 'high' | 'medium' | 'low';
    reason: string;
    analysis_duration_ms: number;
}

class AgentGateEventsCache {
    private static instance: AgentGateEventsCache | null = null;
    private _events: AgentGateEvent[] = [];
    private _totalCount = 0;
    private _denyCount = 0;
    private _allowCount = 0;
    private _polling = false;
    private _timer: ReturnType<typeof setInterval> | null = null;
    /** 推送回调（由 main.ts 提供，负责 IPC 推送到 renderer） */
    private _pushCallback: ((events: AgentGateEvent[], counts: { totalCount: number; denyCount: number; allowCount: number }) => void) | null = null;

    static getInstance(): AgentGateEventsCache {
        if (!AgentGateEventsCache.instance) {
            AgentGateEventsCache.instance = new AgentGateEventsCache();
        }
        return AgentGateEventsCache.instance;
    }

    /** 设置推送回调（由 main.ts 在主进程环境中调用） */
    setPushCallback(callback: (events: AgentGateEvent[], counts: { totalCount: number; denyCount: number; allowCount: number }) => void): void {
        this._pushCallback = callback;
    }

    /** 启动轮询 */
    startPolling(): void {
        if (this._polling) return;
        this._polling = true;
        console.log('[AgentGateEventsCache] Starting events polling');

        // 立即执行一次
        this._pollEvents();

        // 设置定时轮询
        this._timer = setInterval(() => this._pollEvents(), POLL_INTERVAL_MS);
    }

    /** 停止轮询 */
    stopPolling(): void {
        if (!this._polling) return;
        this._polling = false;
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        console.log('[AgentGateEventsCache] Stopped events polling');
    }

    /** 是否正在轮询 */
    isPolling(): boolean {
        return this._polling;
    }

    /** 获取缓存的事件列表 */
    getRecentEvents(): AgentGateEvent[] {
        return [...this._events];
    }

    /** 从 AgentGate HTTP API 获取事件和统计数据 */
    private async _pollEvents(): Promise<void> {
        try {
            const bridge = AgentGateBridge.getInstance();
            const status = bridge.getStatus();

            if (!status.gateRunning) {
                // AgentGate 未运行，清空事件并推送
                if (this._events.length > 0) {
                    this._events = [];
                    this._totalCount = 0;
                    this._denyCount = 0;
                    this._allowCount = 0;
                    this._pushToRenderer();
                }
                return;
            }

            const gatePort = status.gatePort || 9100;
            const baseUrl = `http://127.0.0.1:${gatePort}/api/v1/tool_calls`;

            // 并行请求：事件列表 + Deny 总数 + Allow 总数
            const [eventsResp, denyResp, allowResp] = await Promise.all([
                fetch(`${baseUrl}?limit=${MAX_EVENTS}`, { signal: AbortSignal.timeout(8000) }),
                fetch(`${baseUrl}?decision=Deny&limit=1`, { signal: AbortSignal.timeout(5000) }),
                fetch(`${baseUrl}?decision=Allow&limit=1`, { signal: AbortSignal.timeout(5000) })
            ]);

            if (!eventsResp.ok) {
                console.warn(`[AgentGateEventsCache] HTTP ${eventsResp.status} from events API`);
                return;
            }

            const eventsData = await eventsResp.json();
            // API may return array (old format) or {total, data} (pagination format)
            const events: AgentGateEvent[] = Array.isArray(eventsData) ? eventsData : Array.isArray(eventsData.data) ? eventsData.data : [];

            // 提取全量统计数字（不受 limit=50 限制）
            this._totalCount = typeof eventsData.total === 'number' ? eventsData.total : events.length;

            // 从 Deny/Allow 专属请求提取各自总数
            if (denyResp.ok) {
                const denyData = await denyResp.json();
                this._denyCount = typeof denyData.total === 'number' ? denyData.total : 0;
            }
            if (allowResp.ok) {
                const allowData = await allowResp.json();
                this._allowCount = typeof allowData.total === 'number' ? allowData.total : 0;
            }

            // 按 called_at 降序排序（最新在前）
            const sorted = events.sort((a, b) => {
                const tA = a.called_at ? new Date(a.called_at).getTime() : 0;
                const tB = b.called_at ? new Date(b.called_at).getTime() : 0;
                return tB - tA;
            });

            // 只保留最近 MAX_EVENTS 条
            this._events = sorted.slice(0, MAX_EVENTS);

            // 推送到渲染进程
            this._pushToRenderer();
        } catch (err) {
            // 静默失败，不影响主流程
            console.warn(`[AgentGateEventsCache] Poll error: ${String(err)}`);
        }
    }

    /** 通过回调推送事件和统计数据到渲染进程 */
    private _pushToRenderer(): void {
        if (this._pushCallback) {
            this._pushCallback(this._events, {
                totalCount: this._totalCount,
                denyCount: this._denyCount,
                allowCount: this._allowCount
            });
        }
    }

    /** 检查是否应该轮询（根据浮窗开关和 AgentGate 运行状态） */
    static shouldPoll(): boolean {
        try {
            const setting = Setting.getInstance();
            const data = setting.getData() as any;
            const agConfig = data?.applications?.agentgate || {};
            return agConfig.floatingWindowEnabled === true;
        } catch {
            return false;
        }
    }
}

export { AgentGateEventsCache, type AgentGateEvent };

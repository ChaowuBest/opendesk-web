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
 * 设备管理应用。
 * 提供 OpenClaw Node Protocol 兼容的 WebSocket 网关服务，
 * 允许外部设备节点（macOS/Windows/iOS app 等）直接接入 OpenDesk。
 */

import { z } from 'zod';
import { BaseApplication, type EventDecl } from '../base.js';
import { BaseToolset } from '../../aikernel/tool.js';
import { Skill } from '../../aikernel/skill.js';
import { logger } from '../../utils/logger.js';
import type { ApplicationRegistry } from '../registry.js';
import type { SlashCommandHandler } from '../../tui/commands/index.js';
import { DeviceGateway } from './gateway.js';
import { registerOpenClawMethods } from './gateway-methods.js';
import { SendFileTool } from '../channelmgr/tools.js';
import { DeviceMgrConfigSchema, isDeviceGatewayEnabled, parseDeviceMgrConfig, type DeviceMgrConfig } from './common.js';
import { GlobalState } from '../../aikernel/states/global.js';
import { Setting } from '../../utils/setting.js';
import {
    GetGatewayStatusTool,
    ListConnectedDevicesTool,
    ListPairedDevicesTool,
    ListPendingPairingsTool,
    ApproveDevicePairingTool,
    RejectDevicePairingTool,
    InvokeDeviceCommandTool
} from './tools.js';
import { createNodeExecutionTools } from './node-tools.js';
import { MANAGE_DEVICES_SKILL } from './skills.js';
import { InfoOverlay } from '../../tui/components/notice.js';

export class DeviceMgrApplication extends BaseApplication {
    private gateway: DeviceGateway | null = null;
    private startPromise: Promise<void> | null = null;

    constructor() {
        super('devicemgr', '设备', false);
    }

    static getConfigSchema(): z.ZodObject<any> {
        return DeviceMgrConfigSchema;
    }

    getGateway(): DeviceGateway | null {
        return this.gateway;
    }

    // ── Lifecycle ───────────────────────────────────────────────────────

    /**
     * 覆写 setRegistry：在应用被注册到系统时自动启动网关。
     * serve 模式（opencode/acp）下不自动启动网关。
     */
    setRegistry(registry: typeof ApplicationRegistry): void {
        super.setRegistry(registry);
        if (GlobalState.getInstance().isServeMode()) {
            logger.info('[devicemgr] serve 模式下跳过自动启动网关');
            return;
        }
        this.startGateway().catch((err) => {
            logger.error(`[devicemgr] 自动启动网关失败: ${err?.message || err}`);
        });
    }

    /**
     * 启动 WebSocket 网关服务。幂等调用。
     */
    async startGateway(): Promise<void> {
        if (this.startPromise) return this.startPromise;

        const config = this.resolveConfig();
        if (!isDeviceGatewayEnabled(config)) {
            logger.info('[devicemgr] 设备网关已禁用');
            return;
        }

        this.startPromise = this.doStart(config);
        return this.startPromise;
    }

    private async doStart(config: DeviceMgrConfig): Promise<void> {
        try {
            const dataDir = this.getDataDirectory();
            this.gateway = new DeviceGateway(dataDir, config);

            this.gateway.onEvent((event, payload) => {
                this.emitEvent(event, payload);
            });

            const globalState = GlobalState.getInstance();
            const settingData = Setting.getInstance().getData() as any;

            const outboundToolset = new BaseToolset('channel-outbound');
            outboundToolset.addTool(new SendFileTool());

            registerOpenClawMethods(this.gateway, {
                taskManagerState: globalState.taskManagerState,
                model: settingData?.default_model || undefined,
                workspace: Setting.getInstance().getEffectiveWorkspace(),
                extraToolsets: [outboundToolset]
            });

            await this.gateway.start();
            logger.info(`[devicemgr] 设备网关已启动于 ${config.host}:${config.port}`);
        } catch (err: any) {
            logger.error(`[devicemgr] 网关启动失败: ${err?.message || err}`);
            this.gateway = null;
            this.startPromise = null;
        }
    }

    /**
     * 停止 WebSocket 网关服务。
     */
    async stopGateway(): Promise<void> {
        if (this.gateway) {
            await this.gateway.stop();
            this.gateway = null;
            this.startPromise = null;
        }
    }

    private resolveConfig(): DeviceMgrConfig {
        const raw = this.getConfig() ?? {};
        try {
            return parseDeviceMgrConfig(raw);
        } catch {
            return parseDeviceMgrConfig({});
        }
    }

    async onConfigChanged(): Promise<void> {
        try {
            const config = this.resolveConfig();
            const shouldRun = isDeviceGatewayEnabled(config);

            if (!shouldRun) {
                await this.stopGateway();
                logger.info('[devicemgr] 设备网关已关闭');
                return;
            }

            if (!this.gateway) {
                await this.startGateway();
                return;
            }

            const listenChanged = this.gateway.getHost() !== config.host || this.gateway.getPort() !== config.port;
            if (listenChanged) {
                await this.stopGateway();
                await this.startGateway();
                return;
            }

            this.gateway.updateConfig(config);
        } catch (err: any) {
            logger.error(`[devicemgr] 应用网关配置失败: ${err?.message || err}`);
        }
    }

    // ── Events ──────────────────────────────────────────────────────────

    async getSupportedEvents(): Promise<EventDecl[]> {
        return [
            { eventName: 'device:connected', eventDescription: '设备节点已连接到网关' },
            { eventName: 'device:disconnected', eventDescription: '设备节点已断开连接' },
            { eventName: 'device:pairing-requested', eventDescription: '收到新的设备配对请求' },
            { eventName: 'device:command-result', eventDescription: '设备命令调用完成' }
        ];
    }

    // ── Skills & Tools ──────────────────────────────────────────────────

    async getSkills(): Promise<Skill[]> {
        const skill = Skill.parseMd(MANAGE_DEVICES_SKILL);

        const statusToolset = new BaseToolset('device-status');
        statusToolset.addTool(new GetGatewayStatusTool(this));
        statusToolset.addTool(new ListConnectedDevicesTool(this));
        statusToolset.addTool(new ListPairedDevicesTool(this));

        const pairingToolset = new BaseToolset('device-pairing');
        pairingToolset.addTool(new ListPendingPairingsTool(this));
        pairingToolset.addTool(new ApproveDevicePairingTool(this));
        pairingToolset.addTool(new RejectDevicePairingTool(this));

        const invokeToolset = new BaseToolset('device-invoke');
        invokeToolset.addTool(new InvokeDeviceCommandTool(this));

        skill.toolsets = [statusToolset, pairingToolset, invokeToolset];

        return [skill];
    }

    async getToolsets(): Promise<BaseToolset[]> {
        const toolset = new BaseToolset('devicemgr');
        toolset.addTools(...createNodeExecutionTools(this));
        return [toolset];
    }

    // ── CLI Slash Commands ──────────────────────────────────────────────

    getCliSlashCommands(tui: any): SlashCommandHandler[] {
        return [
            {
                name: 'devices',
                description: '设备管理: /devices status|list|paired|pending',
                getArgumentCompletions: (argPrefix: string) => {
                    const options = ['status', 'list', 'paired', 'pending'];
                    return options
                        .filter((opt) => opt.startsWith(argPrefix.toLowerCase()))
                        .map((opt) => ({
                            value: opt,
                            label: opt,
                            description:
                                {
                                    status: '查看网关状态',
                                    list: '列出在线设备',
                                    paired: '列出已配对设备',
                                    pending: '列出待审批配对'
                                }[opt] || ''
                        }));
                },
                execute: async (args: string) => {
                    await this.handleDevicesCommand(args, tui);
                }
            }
        ];
    }

    private async handleDevicesCommand(args: string, tui: any): Promise<void> {
        const subCmd = args.trim().toLowerCase();

        const showInfo = (title: string, message: string) => {
            try {
                new InfoOverlay(tui, { title, message }).show();
            } catch {
                logger.info(`[devicemgr] ${title}: ${message}`);
            }
        };

        if (!this.gateway?.isRunning()) {
            showInfo('设备网关', '网关未启动');
            return;
        }

        switch (subCmd) {
            case 'status': {
                const connected = this.gateway.getNodeRegistry().listConnected();
                const pairing = this.gateway.getPairingStore().list();
                showInfo(
                    '设备网关状态',
                    [
                        `端口: ${this.gateway.getPort()}`,
                        `监听地址: ${this.gateway.getHost()}`,
                        `网关 ID: ${this.gateway.getIdentity().deviceId.substring(0, 16)}...`,
                        `在线设备: ${connected.length}`,
                        `已配对设备: ${pairing.paired.length}`,
                        `待审批配对: ${pairing.pending.length}`
                    ].join('\n')
                );
                break;
            }
            case 'list': {
                const nodes = this.gateway.getNodeRegistry().listConnected();
                if (nodes.length === 0) {
                    showInfo('在线设备', '当前没有在线设备');
                } else {
                    const lines = nodes.map((n) => {
                        const icon = '●';
                        return `  ${icon} ${n.displayName || n.nodeId.substring(0, 12)} [${n.platform || '?'}] caps=${n.caps.join(',')}`;
                    });
                    showInfo('在线设备', lines.join('\n'));
                }
                break;
            }
            case 'paired': {
                const { paired } = this.gateway.getPairingStore().list();
                if (paired.length === 0) {
                    showInfo('已配对设备', '暂无已配对设备');
                } else {
                    const connectedIds = new Set(
                        this.gateway
                            .getNodeRegistry()
                            .listConnected()
                            .map((n) => n.nodeId)
                    );
                    const lines = paired.map((n) => {
                        const icon = connectedIds.has(n.nodeId) ? '●' : '○';
                        return `  ${icon} ${n.displayName || n.nodeId.substring(0, 12)} [${n.platform || '?'}]`;
                    });
                    showInfo('已配对设备', lines.join('\n'));
                }
                break;
            }
            case 'pending': {
                const { pending } = this.gateway.getPairingStore().list();
                if (pending.length === 0) {
                    showInfo('待审批配对', '暂无待审批的配对请求');
                } else {
                    const lines = pending.map(
                        (r) =>
                            `  ○ ${r.displayName || r.nodeId.substring(0, 12)} [${r.platform || '?'}] id=${r.requestId.substring(0, 8)}`
                    );
                    showInfo('待审批配对', lines.join('\n'));
                }
                break;
            }
            default:
                showInfo('用法提示', '用法: /devices status|list|paired|pending');
        }
    }
}

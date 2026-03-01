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

import { z } from 'zod';
import { parentPort } from 'worker_threads';
import { logger } from '../utils/logger.js';
import { Setting, getAppDirectory } from '../utils/setting.js';
import { BaseToolset } from '../aikernel/tool.js';
import { Skill } from '../aikernel/skill.js';
import type { SlashCommandHandler } from '../tui/commands.js';
import type { ApplicationRegistry } from './registry.js';
import path from 'path';
import fs from 'fs';
import PQueue from 'p-queue';


export interface EventDecl {
    eventName: string;
    eventDescription: string;
}

export class BaseWorker {

    bundleName: string;
    config: object;
    appDataDirectory: string;
    taskQueue: PQueue;

    constructor(bundleName: string, appDataDirectory: string) {
        this.bundleName = bundleName;
        this.config = {};
        this.appDataDirectory = appDataDirectory;
        this.taskQueue = new PQueue({ concurrency: 1 });
    }

    /**
     * 消息处理封装，由上级Worker统一接收消息并调用
     */
    async handleMessage(methodName: string, ...args: any[]): Promise<any> {
        if (typeof (this as any)[methodName] === "function") {
            return await (this as any)[methodName](...args);
        } else {
            throw new Error(`unknown message ${methodName}, implement this method in the worker class`);
        }
    }

    async * handleStreamMessage(methodName: string, ...args: any[]): AsyncGenerator<any> {
        if (typeof (this as any)[methodName] === "function") {
            yield* (this as any)[methodName](...args);
        } else {
            throw new Error(`unknown message ${methodName}, implement this method in the worker class`);
        }
    }

    /**
     * 初始化工作，各个应用的Worker需要自己继承并实现
     */
    async initialize(): Promise<void> { }

    async finalize(): Promise<void> { }

    async applicationConfigChanged(config: object): Promise<void> {
        this.config = config;
    }

    async emitEvent(eventName: string, ...args: any[]): Promise<void> {
        parentPort?.postMessage({
            type: 'emitEvent',
            bundleName: this.bundleName,
            eventName: eventName,
            args: args,
        });
    }

    /**
     * 顺序执行任务
     */
    async runSequentially(task: () => Promise<void>): Promise<void> {
        return await this.taskQueue.add(task);
    }
}

export interface ProtocolHandlerConfig {
    scheme: string;
    privileges?: Electron.Privileges;
    handler: (request: Electron.ProtocolRequest) => Promise<Response> | Response;
}

export abstract class BaseApplication {

    bundleName: string;
    name: string;
    /** 是否在侧边栏应用列表中显示图标，仅提供工具不提供界面的应用可设为 false */
    showIcon: boolean;
    eventSubscribers: Map<string, Set<Electron.WebFrameMain>>;
    registry?: typeof ApplicationRegistry;

    constructor(bundleName: string, name: string = "未命名应用", showIcon: boolean = true) {
        this.bundleName = bundleName;
        this.name = name;
        this.showIcon = showIcon;
        this.eventSubscribers = new Map();
        this.registry = undefined;
    }

    /**
     * 获取应用的工作线程类
     */
    static getWorkerClass(): typeof BaseWorker | undefined {
        return undefined;
    }

    toJSON(): { bundleName: string; name: string; showIcon: boolean } {
        return {
            bundleName: this.bundleName,
            name: this.name,
            showIcon: this.showIcon,
        };
    }

    /**
     * 添加事件订阅者
     */
    addSubscriber(eventName: string, senderFrame: Electron.WebFrameMain): void {
        if (!this.eventSubscribers.has(eventName)) {
            this.eventSubscribers.set(eventName, new Set());
        }
        this.eventSubscribers.get(eventName)!.add(senderFrame);
    }

    /**
     * 移除事件订阅者
     */
    removeSubscriber(eventName: string, senderFrame: Electron.WebFrameMain): void {
        if (this.eventSubscribers.has(eventName)) {
            this.eventSubscribers.get(eventName)!.delete(senderFrame);
        }
    }

    /**
     * 获取应用的自定义协议配置，用于在应用内安全加载资源（如 ppt://）。
     * 每个应用可返回多组配置；主进程会在启动时据此注册 scheme 与 handler。
     */
    getProtocolHandlers(): ProtocolHandlerConfig[] {
        return [];
    }

    /**
     * 发送事件到所有订阅者
     */
    sendEventToSubscribers(eventName: string, ...args: any[]): void {
        const subscribers = this.eventSubscribers.get(eventName);
        if (!subscribers) return;

        for (const subscriber of [...subscribers]) {
            if (typeof subscriber.isDestroyed === 'function' && subscriber.isDestroyed()) {
                subscribers.delete(subscriber);
                continue;
            }
            subscriber.send(`applicationRegistry:event:${eventName}`, ...args);
        }
    }

    /**
     * 缓存的已声明事件名称集合
     * @private
     */
    private _declaredEventsCache: Set<string> | null = null;

    /**
     * 获取已声明的事件名称集合（带缓存）
     * @private
     */
    private async _getDeclaredEvents(): Promise<Set<string>> {
        if (this._declaredEventsCache !== null) {
            return this._declaredEventsCache;
        }
        const events = await this.getSupportedEvents();
        this._declaredEventsCache = new Set(events.map(e => e.eventName));
        return this._declaredEventsCache;
    }

    /**
     * 清除事件声明缓存（当事件声明可能发生变化时调用）
     */
    clearDeclaredEventsCache(): void {
        this._declaredEventsCache = null;
    }

    /**
     * 校验事件名是否已在 getSupportedEvents 中声明
     * @param eventName 事件名称
     * @throws Error 如果事件未声明
     */
    async validateEventName(eventName: string): Promise<void> {
        const declaredEvents = await this._getDeclaredEvents();
        if (!declaredEvents.has(eventName)) {
            throw new Error(
                `Event "${eventName}" is not declared in getSupportedEvents() for application "${this.bundleName}". ` +
                `Please add it to the getSupportedEvents() return value.`
            );
        }
    }

    /**
     * 从主进程侧触发事件
     * 会先校验事件名是否已在 getSupportedEvents 中声明，然后发送给订阅者并转发给 todomgr 进行触发器匹配
     * @param eventName 事件名称
     * @param args 事件参数
     */
    async emitEvent(eventName: string, ...args: any[]): Promise<void> {
        // 校验事件名是否已声明
        await this.validateEventName(eventName);

        // 发送事件给订阅者
        this.sendEventToSubscribers(eventName, ...args);

        if (this.registry) {
            this.registry.dispatchEvent(this.bundleName, eventName, ...args);
        }
    }

    /**
     * 设置应用注册器
     */
    setRegistry(registry: typeof ApplicationRegistry): void {
        this.registry = registry;
    }

    /**
     * 返回应用的配置 schema，用于在设置界面中显示和编辑配置。如果不需要配置，则返回空对象。
     */
    static getConfigSchema(): z.ZodObject<any> {
        return z.object({});
    }

    /**
     * 获取应用的配置
     */
    getConfig(): z.output<z.ZodObject<any>> | undefined {
        return Setting.getInstance().data.applications[this.bundleName];
    }

    setConfig(config: any) {
        const schema: z.ZodObject<any> = Object.getPrototypeOf(this).constructor.getConfigSchema();
        schema.parse(config);
        const setting = Setting.getInstance();
        setting.data.applications[this.bundleName] = config;
        setting.save();
    }

    /**
     * 配置发生变化时调用
     */
    onConfigChanged(): void {
        logger.info(`application ${this.bundleName} config changed`);
    }

    /**
     * 获取应用提供的工具
     */
    async getToolsets(): Promise<BaseToolset[]> {
        return [];
    }

    /**
     * 获取应用提供的Skills
     * @returns
     */
    async getSkills(): Promise<Skill[]> {
        return [];
    }

    /**
     * 获取应用能够注册的事件
     */
    async getSupportedEvents(): Promise<EventDecl[]> {
        return [];
    }

    /**
     * 获取应用提供的 CLI 斜杠命令
     * 应用可以重写此方法来注册自己的斜杠命令
     * @param tui TUI 实例，用于显示 overlay 等
     * @returns SlashCommandHandler 数组
     */
    getCliSlashCommands(tui: any): SlashCommandHandler[] {
        return [];
    }

    async getDataDirectory(): Promise<string> {
        let data_directory = path.join(await getAppDirectory(), 'apps', this.bundleName);
        if (!fs.existsSync(data_directory)) {
            fs.mkdirSync(data_directory, { recursive: true });
        }
        return data_directory;
    }

    async callWorker(methodName: string, ...args: any[]): Promise<any> {
        if (this.registry === undefined) {
            throw new Error(`application's registry is not configured`);
        }
        return await this.registry.callWorker(this.bundleName, methodName, ...args);
    }
}

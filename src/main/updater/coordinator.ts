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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isNewerVersion, isValidVersion } from '../utils/version.js';
import type { ReadyUpdateRecord, UpdateRelease, UpdateServiceResponse, UpdateState } from './types.js';

export interface UpdateCoordinatorDependencies {
    currentVersion: string;
    stateDirectory: string;
    fetchRelease: () => Promise<UpdateRelease>;
    download: (
        release: UpdateRelease,
        destination: string,
        onProgress: (receivedBytes: number, totalBytes?: number) => void
    ) => Promise<void>;
    verify: (release: UpdateRelease, installerPath: string) => Promise<string>;
    submitToService: (record: ReadyUpdateRecord) => Promise<UpdateServiceResponse>;
    getActiveTasks: () => string[];
    stopActiveTasks: (taskIds: string[]) => Promise<void>;
    flushState: () => Promise<void>;
    prepareWindowsForQuit: () => Promise<boolean>;
    relaunch: () => void;
    quit: () => void;
    // 手动安装模式（macOS 一期）：下载校验完成后停在 ready 等用户挂载 DMG，不经系统服务自动安装
    manualInstall?: boolean;
    // 安装包扩展名校验：Windows 为 .exe（默认），macOS 为 .dmg
    installerExtension?: string;
    onStateChanged?: (state: UpdateState) => void;
}

export class UpdateCoordinator {
    private state: UpdateState = { status: 'idle' };
    private operation?: Promise<UpdateState>;
    private pendingRecord?: ReadyUpdateRecord;
    private installedRecord?: Pick<ReadyUpdateRecord, 'version' | 'notes'>;
    readonly dependenciesForTesting: UpdateCoordinatorDependencies;

    constructor(private readonly dependencies: UpdateCoordinatorDependencies) {
        this.dependenciesForTesting = dependencies;
    }

    getState(): UpdateState {
        if (this.state.status !== 'ready' && this.state.status !== 'installed') return { ...this.state };
        return { ...this.state, activeTaskCount: this.dependencies.getActiveTasks().length };
    }

    private setState(state: UpdateState): UpdateState {
        this.state = state;
        const publicState = this.getState();
        this.dependencies.onStateChanged?.(publicState);
        return publicState;
    }

    private get readyRecordPath(): string {
        return path.join(this.dependencies.stateDirectory, 'ready.json');
    }

    private get expectedInstallerExtension(): string {
        return (this.dependencies.installerExtension ?? '.exe').toLowerCase();
    }

    async restore(): Promise<UpdateState> {
        try {
            const raw = JSON.parse(await fs.promises.readFile(this.readyRecordPath, 'utf8')) as ReadyUpdateRecord;
            if (
                typeof raw.requestId !== 'string' ||
                !/^[0-9a-f-]{36}$/i.test(raw.requestId) ||
                typeof raw.version !== 'string' ||
                // 版本号必须是合法 SemVer：isNewerVersion 对解析不了的版本会退化成字符串不等于，
                // 记录里写坏的版本号就会绕过下面「必须比本地新」这道闸门
                !isValidVersion(raw.version) ||
                typeof raw.installerPath !== 'string' ||
                typeof raw.sha256 !== 'string' ||
                !/^[0-9a-f]{64}$/i.test(raw.sha256) ||
                // 远端发布版本必须比本地更新（本地可能是预发布/开发构建，按 SemVer 优先级比较）
                !isNewerVersion(raw.version, this.dependencies.currentVersion) ||
                path.dirname(path.resolve(raw.installerPath)) !== path.resolve(this.dependencies.stateDirectory) ||
                !raw.installerPath.toLowerCase().endsWith(this.expectedInstallerExtension) ||
                !fs.existsSync(raw.installerPath)
            ) {
                await this.discardRecord(raw);
                return this.setState({ status: 'idle' });
            }
            this.pendingRecord = raw;
            return this.setState({ ...raw, status: 'ready', activeTaskCount: 0 });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                await fs.promises.rm(this.readyRecordPath, { force: true });
            }
            return this.setState({ status: 'idle' });
        }
    }

    async checkForUpdates(): Promise<UpdateState> {
        if (
            this.state.status === 'installed' ||
            this.state.status === 'restarting' ||
            this.state.status === 'installing'
        ) {
            return this.getState();
        }
        if (this.operation) return this.operation;
        if (this.pendingRecord) {
            // macOS 一期：待安装包只等用户手动处理，定时重查不再自动提交系统服务
            if (this.dependencies.manualInstall) return this.getState();
            this.operation = this.submitRecord(this.pendingRecord).finally(() => {
                this.operation = undefined;
            });
            return this.operation;
        }
        this.operation = this.performCheck().finally(() => {
            this.operation = undefined;
        });
        return this.operation;
    }

    private async performCheck(): Promise<UpdateState> {
        this.setState({ status: 'checking' });
        try {
            const release = await this.dependencies.fetchRelease();
            if (!isNewerVersion(release.version, this.dependencies.currentVersion)) {
                return this.setState({ status: 'upToDate', checkedAt: new Date().toISOString() });
            }
            const safeName = path.basename(release.installerName);
            if (
                safeName !== release.installerName ||
                !safeName.toLowerCase().endsWith(this.expectedInstallerExtension)
            ) {
                throw new Error('Release contains an invalid installer filename');
            }
            await fs.promises.mkdir(this.dependencies.stateDirectory, { recursive: true });
            const installerPath = path.join(this.dependencies.stateDirectory, safeName);
            this.setState({
                status: 'downloading',
                version: release.version,
                receivedBytes: 0,
                totalBytes: release.size
            });
            await this.dependencies.download(release, installerPath, (receivedBytes, totalBytes) => {
                this.setState({ status: 'downloading', version: release.version, receivedBytes, totalBytes });
            });
            const sha256 = await this.dependencies.verify(release, installerPath);
            const record: ReadyUpdateRecord = {
                requestId: crypto.randomUUID(),
                version: release.version,
                installerPath,
                sha256,
                notes: release.notes
            };
            await fs.promises.writeFile(`${this.readyRecordPath}.tmp`, JSON.stringify(record, null, 4), 'utf8');
            await fs.promises.rm(this.readyRecordPath, { force: true });
            await fs.promises.rename(`${this.readyRecordPath}.tmp`, this.readyRecordPath);
            this.pendingRecord = record;
            const readyState = this.setState({ ...record, status: 'ready', activeTaskCount: 0 });
            // macOS 一期：包就绪即停在 ready，由用户手动挂载 DMG 安装，不自动提交系统服务
            if (this.dependencies.manualInstall) return readyState;
            return await this.submitRecord(record);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return this.setState({ status: 'error', code: 'update_check_failed', message });
        }
    }

    async submitPendingUpdate(): Promise<boolean> {
        // 手动安装模式下安装由用户完成，协调器永远不会经系统服务走到 installed
        if (this.dependencies.manualInstall) return false;
        if (!this.pendingRecord || this.state.status !== 'ready') return false;
        if (this.operation) {
            await this.operation;
            return (this.state as UpdateState).status === 'installed';
        }
        this.operation = this.submitRecord(this.pendingRecord).finally(() => {
            this.operation = undefined;
        });
        await this.operation;
        return (this.state as UpdateState).status === 'installed';
    }

    private async submitRecord(record: ReadyUpdateRecord): Promise<UpdateState> {
        this.setState({ status: 'installing', version: record.version });
        let response: UpdateServiceResponse;
        try {
            response = await this.dependencies.submitToService(record);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return this.setState({ status: 'error', code: 'update_service_unavailable', message });
        }

        if (response.status === 'installed' && response.code === 'installed') {
            this.installedRecord = { version: record.version, notes: record.notes };
            await this.discardRecord(record);
            return this.setState({
                status: 'installed',
                version: record.version,
                notes: record.notes,
                activeTaskCount: 0
            });
        }
        if (response.status === 'busy') {
            return this.setState({ status: 'error', code: 'update_service_busy', message: response.code });
        }
        if (response.status === 'rejected') {
            await this.discardRecord(record);
            return this.setState({
                status: 'error',
                code: 'update_package_rejected',
                message: response.message || response.code
            });
        }
        await this.discardRecord(record);
        return this.setState({
            status: 'error',
            code: 'update_install_failed',
            message: response.message || response.code
        });
    }

    async restartToApplyUpdate(): Promise<boolean> {
        if (this.state.status !== 'installed' || !this.installedRecord) return false;
        const installed = this.installedRecord;
        const activeTasks = this.dependencies.getActiveTasks();
        this.setState({ status: 'restarting', version: installed.version });
        try {
            await this.dependencies.stopActiveTasks(activeTasks);
            await this.dependencies.flushState();
            if (!(await this.dependencies.prepareWindowsForQuit())) {
                this.setState({ ...installed, status: 'installed', activeTaskCount: 0 });
                return false;
            }
            this.dependencies.relaunch();
            this.dependencies.quit();
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.setState({ status: 'error', code: 'update_restart_failed', message });
            return false;
        }
    }

    private async discardRecord(record: Partial<ReadyUpdateRecord>): Promise<void> {
        if (
            typeof record.installerPath === 'string' &&
            path.dirname(path.resolve(record.installerPath)) === path.resolve(this.dependencies.stateDirectory)
        ) {
            await fs.promises.rm(record.installerPath, { force: true });
        }
        await fs.promises.rm(this.readyRecordPath, { force: true });
        this.pendingRecord = undefined;
    }
}

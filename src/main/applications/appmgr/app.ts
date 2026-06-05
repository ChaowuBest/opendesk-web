/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { BaseApplication } from '../base.js';
import { BaseToolset } from '../../aikernel/tool.js';
import { Skill } from '../../aikernel/skill.js';
import {
    AppManagerStore,
    appEntryUrl,
    readAppManifestFromZipFile,
    toPublicUserApp,
    type UserAppRecord
} from './manager.js';
import { MANAGE_APPS_SKILL } from './skills.js';
import { GetAppInfoTool, InstallAppTool, ListAppsTool } from './tools.js';

const APPMGR_ICON_URL = './applications/skillmgr/icon.png';

export class AppMgrApplication extends BaseApplication {
    static bundleName: string = 'appmgr';

    constructor() {
        super('appmgr', '应用管理');
    }

    toJSON(): Record<string, unknown> {
        return {
            ...super.toJSON(),
            iconUrl: APPMGR_ICON_URL,
            source: 'system',
            removable: false,
            active: true
        };
    }

    async getSkills(): Promise<Skill[]> {
        const skill = Skill.parseMd(MANAGE_APPS_SKILL);
        const toolset = new BaseToolset('manage-apps');
        toolset.addTool(new InstallAppTool(this));
        toolset.addTool(new ListAppsTool(this));
        toolset.addTool(new GetAppInfoTool(this));
        skill.toolsets = [toolset];
        return [skill];
    }

    async getToolsets(): Promise<BaseToolset[]> {
        const toolset = new BaseToolset('appmgr');
        toolset.addTool(new InstallAppTool(this));
        toolset.addTool(new ListAppsTool(this));
        toolset.addTool(new GetAppInfoTool(this));
        return [toolset];
    }

    installFromZip(zipPath: string) {
        const manifest = readAppManifestFromZipFile(zipPath);
        this.assertNotSystemBundle(manifest.bundleName);
        const result = AppManagerStore.installFromZip(zipPath);
        this.refreshExternalApplications();
        return {
            app: toPublicUserApp(result.app),
            version: result.version
        };
    }

    createApp(input: { bundleName: string; displayName: string; description?: string }) {
        this.assertNotSystemBundle(input.bundleName);
        const result = AppManagerStore.createApp(input);
        this.refreshExternalApplications();
        return {
            app: toPublicUserApp(result.app),
            version: result.version
        };
    }

    listUserApps() {
        return AppManagerStore.listApps().map((app) => toPublicUserApp(app));
    }

    listBuiltinApps() {
        const apps = Array.from(this.registry?.applications?.values?.() ?? []) as BaseApplication[];
        return apps
            .filter((app) => !AppManagerStore.getApp(app.bundleName))
            .map((app) => ({
                ...app.toJSON(),
                iconUrl: (app.toJSON() as any).iconUrl || `./applications/${app.bundleName}/icon.png`,
                source: 'system',
                removable: false,
                active: true
            }));
    }

    async listAllApps() {
        return {
            userApps: this.listUserApps(),
            builtinApps: this.listBuiltinApps()
        };
    }

    getAppInfo(bundleName: string) {
        const userApp = AppManagerStore.getApp(bundleName);
        if (userApp) {
            return toPublicUserApp(userApp);
        }
        const builtinApp = this.registry?.getApplication?.(bundleName) as BaseApplication | undefined;
        if (!builtinApp) {
            throw new Error(`application ${bundleName} not found`);
        }
        return {
            ...builtinApp.toJSON(),
            iconUrl: (builtinApp.toJSON() as any).iconUrl || `./applications/${builtinApp.bundleName}/icon.png`,
            source: 'system',
            removable: false,
            active: true
        };
    }

    setActive(bundleName: string, active: boolean) {
        const app = AppManagerStore.setActive(bundleName, active);
        this.refreshExternalApplications();
        return toPublicUserApp(app);
    }

    setCurrentVersion(bundleName: string, versionId: string) {
        const app = AppManagerStore.setCurrentVersion(bundleName, versionId);
        this.refreshExternalApplications();
        return toPublicUserApp(app);
    }

    updateMetadata(input: { bundleName: string; displayName?: string; description?: string; iconSourcePath?: string }) {
        const app = AppManagerStore.updateMetadata(input);
        this.refreshExternalApplications();
        return toPublicUserApp(app);
    }

    deleteApp(bundleName: string) {
        const result = AppManagerStore.deleteApp(bundleName);
        this.refreshExternalApplications();
        return result;
    }

    getPreviewUrl(bundleName: string, versionId?: string) {
        const app = AppManagerStore.getAppOrThrow(bundleName);
        return appEntryUrl(app, versionId ?? app.currentVersionId);
    }

    private refreshExternalApplications(): void {
        this.registry?.reloadExternalApplications?.();
        this.registry?.notifyApplicationListChanged?.();
    }

    private assertNotSystemBundle(bundleName: string): void {
        const existing = this.registry?.getApplication?.(bundleName) as BaseApplication | undefined;
        if (existing && !AppManagerStore.getApp(bundleName)) {
            throw new Error(`bundleName ${bundleName} conflicts with a system application`);
        }
    }
}

export type { UserAppRecord };

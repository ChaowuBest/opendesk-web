import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { getGuiApplicationClasses } from '../../../platforms/applications.js';
import { AdminConsoleApplication } from '../../../main/applications/adminconsole/app.js';
import { isApplicationVisibleInMenu } from '../../../renderer/utils/application-visibility.js';

const sidebarSource = readFileSync(new URL('../../../renderer/components/sidebar.js', import.meta.url), 'utf8');
const rendererHtml = readFileSync(new URL('../../../renderer/index.html', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../../../main/main.ts', import.meta.url), 'utf8');

describe('adminconsole application registration', () => {
    const application = new AdminConsoleApplication();

    test('registers under the adminconsole bundle name', () => {
        expect(application.bundleName).toBe('adminconsole');
    });

    test('stays hidden from the application list', () => {
        expect(application.showIcon).toBe(false);
        expect(isApplicationVisibleInMenu(application.toJSON(), undefined)).toBe(false);
    });

    test('exposes the main-world methods the entry widget calls', () => {
        const methods = [
            'getServerUrl',
            'loadToken',
            'verifyToken',
            'clearToken',
            'getDailyStats',
            'getSummaryStats',
            'getFeedbackList',
            'downloadAttachment'
        ];
        for (const method of methods) {
            expect(typeof (application as any)[method]).toBe('function');
        }
    });
});

describe('adminconsole wiring', () => {
    test('is registered as a platform application', () => {
        expect(getGuiApplicationClasses()).toContain(AdminConsoleApplication);
    });

    test('opens from the debug menu instead of a dedicated renderer overlay', () => {
        const debugMenuSource = sidebarSource.slice(
            sidebarSource.indexOf('_showDebugMenu(event) {'),
            sidebarSource.indexOf('_showTaskInfoModal(')
        );
        expect(debugMenuSource).toContain("this._t('renderer.toolbar.admin')");
        expect(debugMenuSource).toContain("openApplication('adminconsole')");
        expect(sidebarSource).not.toContain('openAdminPanel');
        expect(rendererHtml).not.toContain('openAdminPanel');
    });

    test('no longer exposes admin endpoints through global main-process IPC', () => {
        expect(mainSource).not.toContain("ipcMain.handle('admin:");
    });
});

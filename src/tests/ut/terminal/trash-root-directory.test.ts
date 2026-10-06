import { describe, expect, test } from '@jest/globals';
import path from 'node:path';
import { resolveTrashRootDirectory } from '../../../main/utils/setting.js';

/**
 * 回归：BUG 任务（task_muv7f1f7_uxay）中"无法删除"——rm 报 Cross-device link。
 *
 * 根因：OpenHarmony 平台上 OpenDesk 应用数据目录（appDataDir，如
 * /data/storage/el2/base/files，设备 A）与用户文件（userHomeDir/Documents，设备 B）
 * 位于不同文件系统。任务级回收站原为 `<appDataDir>/trash/<taskId>`，沙箱
 * --del-to-trash 将 unlink 重定向为 rename 到回收站 → 跨设备 rename 返回 EXDEV
 * → fail-closed 拒绝删除（文件永久无法删除）。
 *
 * 修复：OH 平台统一回收站根目录改为 `<userHomeDir>/.opendesk-trash`（与用户文件
 * 同设备，rename 可成功；GUI 回收站展示/恢复走同一 getTaskTrashDirectory）。
 */
describe('resolveTrashRootDirectory（回收站根目录平台判定）', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

    function withPlatform(platform: string, run: () => void): void {
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });
        try {
            run();
        } finally {
            if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
        }
    }

    test('OH 平台：回收站根目录位于用户家目录 .opendesk-trash（与用户文件同设备）', () => {
        withPlatform('openharmony', () => {
            expect(resolveTrashRootDirectory('/data/storage/el2/base/files', '/storage/Users/currentUser')).toBe(
                '/storage/Users/currentUser/.opendesk-trash'
            );
        });
    });

    test('OH 平台：无家目录（tablet 等场景）回退应用数据目录 trash', () => {
        withPlatform('openharmony', () => {
            expect(resolveTrashRootDirectory('/data/storage/el2/base/files', undefined)).toBe(
                '/data/storage/el2/base/files/trash'
            );
        });
    });

    test('Linux/macOS：保持 <opendeskDir>/trash（不回归）', () => {
        withPlatform('linux', () => {
            expect(resolveTrashRootDirectory('/home/liyi/.opendesk', '/home/liyi')).toBe('/home/liyi/.opendesk/trash');
        });
        withPlatform('darwin', () => {
            expect(resolveTrashRootDirectory('/Users/liyi/Library/opendesk', '/Users/liyi')).toBe(
                '/Users/liyi/Library/opendesk/trash'
            );
        });
    });

    test('Windows：保持 <opendeskDir>/trash（Windows 回收站路径由 SHFileOperation 管理；分隔符随运行平台）', () => {
        withPlatform('win32', () => {
            // 注意：path.join 的分隔符取决于真实运行平台（OH/Linux 上为 /），仅验证目录拼接语义
            expect(resolveTrashRootDirectory('C:\\Users\\liyi\\AppData\\Roaming\\opendesk', 'C:\\Users\\liyi')).toBe(
                path.join('C:\\Users\\liyi\\AppData\\Roaming\\opendesk', 'trash')
            );
        });
    });
});

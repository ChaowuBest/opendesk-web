import { PluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { definePlugin } from '../../../../packages/plugin-sdk/src/index.js';

/**
 * 加载期的宿主版本闸门。
 *
 * 与安装期闸门（management/manager.ts）、市场卡片共用 catalog-common 的判定，
 * 这里锁定诊断码、方向与 detail 的稳定格式：宿主降级/升级后用户看到的原因
 * 必须与「为什么装不上」一致。
 */
describe('PluginHost 宿主版本闸门', () => {
    test('宿主低于清单声明的下界时拒绝加载并给出 too_old 诊断', async () => {
        const host = new PluginHost();
        const entry = await host.activate(
            definePlugin({ id: 'needs-newer-host', minOpenDeskVersion: '2.0.0', setup() {} }),
            { origin: 'test:needs-newer-host', hostVersion: '0.4' }
        );

        expect(entry.status).toBe('error');
        // 两段式宿主版本补齐 PATCH 后比较，detail 保持「当前版本 < 声明边界」的稳定格式
        expect(entry.diagnostics).toContainEqual({
            code: 'plugin.opendesk_version_too_old',
            stage: 'validate',
            detail: '0.4 < 2.0.0'
        });
    });

    test('宿主高于清单声明的上界时给出 too_new 诊断', async () => {
        const host = new PluginHost();
        const entry = await host.activate(
            definePlugin({ id: 'only-old-host', maxOpenDeskVersion: '0.3.0', setup() {} }),
            { origin: 'test:only-old-host', hostVersion: '0.4.1' }
        );

        expect(entry.status).toBe('error');
        expect(entry.diagnostics).toContainEqual({
            code: 'plugin.opendesk_version_too_new',
            stage: 'validate',
            detail: '0.4.1 > 0.3.0'
        });
    });

    test('两段式宿主版本不会被误判成 too_new', async () => {
        const host = new PluginHost();
        // 0.4 按 0.4.0 处理，落在 ≤ 0.9.0 内；旧实现解析失败会直接判越界，把插件挡在门外
        const entry = await host.activate(
            definePlugin({ id: 'two-segment-host', maxOpenDeskVersion: '0.9.0', setup() {} }),
            { origin: 'test:two-segment-host', hostVersion: '0.4' }
        );

        expect(entry.status).toBe('active');
        expect(entry.diagnostics).toEqual([]);
    });

    test('两段式宿主版本不会被误判成 too_old', async () => {
        const host = new PluginHost();
        // 0.4 按 0.4.0 处理，满足 ≥ 0.1.0；旧实现解析失败会判成低于下界
        const entry = await host.activate(
            definePlugin({ id: 'two-segment-lower-host', minOpenDeskVersion: '0.1.0', setup() {} }),
            { origin: 'test:two-segment-lower-host', hostVersion: '0.4' }
        );

        expect(entry.status).toBe('active');
        expect(entry.diagnostics).toEqual([]);
    });

    test('范围满足（含边界）时正常激活', async () => {
        const host = new PluginHost();
        let setupCalled = false;
        const entry = await host.activate(
            definePlugin({
                id: 'compatible-host',
                minOpenDeskVersion: '0.4.1',
                maxOpenDeskVersion: '0.4.1',
                setup() {
                    setupCalled = true;
                }
            }),
            { origin: 'test:compatible-host', hostVersion: '0.4.1' }
        );

        expect(entry.status).toBe('active');
        expect(setupCalled).toBe(true);
    });
});

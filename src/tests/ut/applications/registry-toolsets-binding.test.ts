import { BaseApplication } from '../../../../packages/app-sdk/src/index.js';
import { ApplicationRegistry } from '../../../main/applications/registry.js';

/**
 * 复刻 SearchApplication.getToolsets 的实现模式：方法体内读取 this。
 * listAvailableToolsets 若把 getToolsets 摘成裸函数调用，this 为 undefined，
 * 会抛 "Cannot read properties of undefined (reading 'bundleName')"，
 * 导致所有任务构建 toolset 失败（对话无法打开）。
 */
class ThisSensitiveApplication extends BaseApplication {
    static readonly BUNDLE_NAME = 'ut-this-sensitive-app';

    constructor() {
        super(ThisSensitiveApplication.BUNDLE_NAME);
    }

    getName(): string {
        return 'UT ThisSensitive';
    }

    async getToolsets(): Promise<any[]> {
        const name = this.bundleName;
        return [{ name, marker: 'this-bound' }];
    }
}

class BrokenToolsetsApplication extends BaseApplication {
    static readonly BUNDLE_NAME = 'ut-broken-toolsets-app';

    constructor() {
        super(BrokenToolsetsApplication.BUNDLE_NAME);
    }

    getName(): string {
        return 'UT Broken';
    }

    async getToolsets(): Promise<any[]> {
        throw new Error('toolsets exploded');
    }
}

describe('ApplicationRegistry.listAvailableToolsets this 绑定', () => {
    test('以应用实例为 this 调用 getToolsets，实现内读取 this 不抛错', async () => {
        const app = new ThisSensitiveApplication();
        ApplicationRegistry.registerApplication(app);

        const toolsets = await ApplicationRegistry.listAvailableToolsets();

        expect(toolsets).toContainEqual({
            name: ThisSensitiveApplication.BUNDLE_NAME,
            marker: 'this-bound'
        });
    });

    test('单个应用构建工具集失败不会拖垮整轮任务', async () => {
        ApplicationRegistry.registerApplication(new BrokenToolsetsApplication());

        const toolsets = await ApplicationRegistry.listAvailableToolsets();

        // 抛错应用被跳过，其余应用的工具集与顺序保持不变
        expect(toolsets).toContainEqual({ name: ThisSensitiveApplication.BUNDLE_NAME, marker: 'this-bound' });
        expect(toolsets.some((toolset: any) => toolset?.name === BrokenToolsetsApplication.BUNDLE_NAME)).toBe(false);
    });
});

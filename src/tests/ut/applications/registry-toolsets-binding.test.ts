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
});

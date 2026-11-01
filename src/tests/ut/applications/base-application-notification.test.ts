import { afterEach, expect, jest, test } from '@jest/globals';
import { BaseApplication } from '../../../main/applications/base.js';
import { NotificationManager } from '../../../main/utils/notificationmgr.js';

class DemoApplication extends BaseApplication {
    getName(): string {
        return 'Demo';
    }
}

afterEach(() => {
    jest.restoreAllMocks();
});

test('BaseApplication.sendNotification 把通知交给宿主注入的通知中枢', () => {
    const send = jest.spyOn(NotificationManager.getInstance(), 'sendNotification').mockImplementation(() => undefined);

    const application = new DemoApplication('demo');
    application.sendNotification('info', '插件中心', '启用成功', '插件已启用：demo-plugin');

    expect(send).toHaveBeenCalledWith('info', '插件中心', '启用成功', '插件已启用：demo-plugin');
});

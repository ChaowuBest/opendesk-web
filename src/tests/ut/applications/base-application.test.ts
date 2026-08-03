import { jest } from '@jest/globals';
import { BaseApplication } from '../../../../packages/appsdk/src/index.js';

class TestApplication extends BaseApplication {
    constructor() {
        super('test');
    }

    getName(): string {
        return 'Test';
    }
}

class AgentBarApplication extends TestApplication {
    needAgentBar(): boolean {
        return true;
    }
}

describe('BaseApplication event subscribers', () => {
    test('keeps same-frame event subscription until every listener unsubscribes', () => {
        const app = new TestApplication();
        const senderFrame = {
            isDestroyed: jest.fn(() => false),
            send: jest.fn()
        };

        app.addSubscriber('updated', senderFrame);
        app.addSubscriber('updated', senderFrame);
        app.removeSubscriber('updated', senderFrame);

        app.sendEventToSubscribers('updated', { value: 1 });

        expect(senderFrame.send).toHaveBeenCalledTimes(1);
        expect(senderFrame.send).toHaveBeenCalledWith('applicationRegistry:event:updated', { value: 1 });

        app.removeSubscriber('updated', senderFrame);
        app.sendEventToSubscribers('updated', { value: 2 });

        expect(senderFrame.send).toHaveBeenCalledTimes(1);
    });
});

describe('BaseApplication GUI config', () => {
    test('hides the floating agent bar by default', () => {
        expect(new TestApplication().toJSON()).toMatchObject({ needAgentBar: false });
    });

    test('serializes an application agent bar opt-in', () => {
        expect(new AgentBarApplication().toJSON()).toMatchObject({ needAgentBar: true });
    });
});

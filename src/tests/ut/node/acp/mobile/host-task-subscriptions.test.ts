import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    BaseTaskUpdateSubscriber,
    TaskState,
    TaskUpdateChunk
} from '../../../../../main/aikernel/states/tasks.js';
import type { BaseTaskManagerUpdateSubscriber, TaskManagerState } from '../../../../../main/aikernel/task/manager.js';
import {
    subscribeMobileTaskManagerUpdates,
    subscribeMobileTaskUpdates
} from '../../../../../main/applications/mobileaccess/acp/mobile/hosts/task-subscriptions.js';
import type {
    RemoteTaskManagerSubscriber,
    RemoteTaskUpdateSubscriber
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-sync.js';

class SubscriberRegistry<T extends { subscription_id: string }> {
    readonly added: T[] = [];
    readonly removed: string[] = [];

    add(subscriber: T): string {
        this.added.push(subscriber);
        return subscriber.subscription_id;
    }

    remove(id: string): void {
        this.removed.push(id);
    }
}

function taskDouble(): { task: TaskState; registry: SubscriberRegistry<BaseTaskUpdateSubscriber> } {
    const registry = new SubscriberRegistry<BaseTaskUpdateSubscriber>();
    const task = {
        addSubscriber: (subscriber: BaseTaskUpdateSubscriber) => registry.add(subscriber),
        removeSubscriber: (id: string) => registry.remove(id)
    } as unknown as TaskState;
    return { task, registry };
}

function managerDouble(): { manager: TaskManagerState; registry: SubscriberRegistry<BaseTaskManagerUpdateSubscriber> } {
    const registry = new SubscriberRegistry<BaseTaskManagerUpdateSubscriber>();
    const manager = {
        addSubscriber: (subscriber: BaseTaskManagerUpdateSubscriber) => registry.add(subscriber),
        removeSubscriber: (id: string) => registry.remove(id)
    } as unknown as TaskManagerState;
    return { manager, registry };
}

test('the task bridge forwards availability and chunks without asking for HTML rendering', () => {
    const { task, registry } = taskDouble();
    const received: unknown[] = [];
    let available = true;
    const delegate: RemoteTaskUpdateSubscriber = {
        subscription_id: 'delegate-task',
        wantsHtmlRender: false,
        isAvailable: () => available,
        send: (chunk) => {
            received.push(chunk);
        }
    };

    const unsubscribe = subscribeMobileTaskUpdates(task, delegate);
    assert.equal(registry.added.length, 1);
    const bridge = registry.added[0];
    assert.equal(bridge.wantsHtmlRender, false);
    assert.equal(bridge.isAvailable(), true);
    available = false;
    assert.equal(bridge.isAvailable(), false);

    const chunk = { type: 'assistant', content: 'hello' } as unknown as TaskUpdateChunk;
    bridge.send(chunk);
    assert.deepEqual(received, [chunk]);

    unsubscribe();
    assert.deepEqual(registry.removed, [bridge.subscription_id]);
});

test('the task manager bridge forwards availability and task lists under its own subscription id', () => {
    const { manager, registry } = managerDouble();
    const received: Array<readonly object[]> = [];
    let available = false;
    const delegate: RemoteTaskManagerSubscriber = {
        subscription_id: 'delegate-manager',
        isAvailable: () => available,
        send: (taskList) => {
            received.push(taskList);
        }
    };

    const unsubscribe = subscribeMobileTaskManagerUpdates(manager, delegate);
    assert.equal(registry.added.length, 1);
    const bridge = registry.added[0];
    assert.equal(bridge.isAvailable(), false);
    available = true;
    assert.equal(bridge.isAvailable(), true);

    const taskList = [{ task_id: 'a' }];
    bridge.send(taskList);
    assert.deepEqual(received, [taskList]);

    unsubscribe();
    assert.deepEqual(registry.removed, [bridge.subscription_id]);
});

test('each subscription gets an independent bridge and cancels only its own registration', () => {
    const { task, registry } = taskDouble();
    const inert: RemoteTaskUpdateSubscriber = {
        subscription_id: 'inert',
        wantsHtmlRender: false,
        isAvailable: () => true,
        send: () => undefined
    };
    const first = subscribeMobileTaskUpdates(task, inert);
    subscribeMobileTaskUpdates(task, inert);

    assert.equal(registry.added.length, 2);
    assert.notEqual(registry.added[0], registry.added[1]);
    assert.notEqual(registry.added[0].subscription_id, registry.added[1].subscription_id);

    first();
    assert.deepEqual(registry.removed, [registry.added[0].subscription_id]);
});

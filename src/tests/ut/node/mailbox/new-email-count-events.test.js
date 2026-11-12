import assert from 'node:assert/strict';
import test from 'node:test';

import MailboxWorker from '../../../../main/applications/mailbox/service/worker.js';

/**
 * 构造一个只保留计数相关状态的最小 worker 实例。
 * 真实构造会拉起配置、存储与网络客户端，这里只测计数与事件派发逻辑。
 */
function createWorker({ profiles = ['a@example.com'], currentProfileId = 'a@example.com' } = {}) {
    const worker = Object.create(MailboxWorker.prototype);
    worker.profileMap = new Map(profiles.map((id) => [id, { name: id }]));
    worker.storageMap = new Map(profiles.map((id) => [id, {}]));
    worker.newEmailCounts = new Map();
    worker.currentProfileId = currentProfileId;
    worker.isMailboxOpened = false;
    worker.events = [];
    worker.emitEvent = (eventName, payload) => {
        worker.events.push({ eventName, payload });
    };
    return worker;
}

test('clearNewEmailCount 在计数本来就是 0 时不派发事件', () => {
    const worker = createWorker();

    worker.clearNewEmailCount('a@example.com');

    assert.equal(worker.events.length, 0, '未读为 0 时清理不应产生事件');
    assert.equal(worker.getNewEmailCount('a@example.com'), 0);
});

test('clearNewEmailCount 在计数非 0 时清理并派发一次事件', () => {
    const worker = createWorker();
    worker.newEmailCounts.set('a@example.com', 3);

    worker.clearNewEmailCount('a@example.com');

    assert.equal(worker.events.length, 1);
    assert.equal(worker.events[0].eventName, 'newEmailCountsUpdated');
    assert.deepEqual(worker.events[0].payload, { 'a@example.com': 0 });
    assert.equal(worker.getNewEmailCount('a@example.com'), 0);
});

test('重复 notifyMailboxOpened 只处理一次（主窗口与邮件界面各通知一次的场景）', () => {
    const worker = createWorker();
    worker.newEmailCounts.set('a@example.com', 2);

    // 主窗口 openApplication 代通知一次，iframe 内组件挂载后再通知一次
    worker.notifyMailboxOpened();
    worker.notifyMailboxOpened();

    assert.equal(worker.events.length, 1, '同一轮打开只应派发一次清理事件');
    assert.equal(worker.isMailboxOpened, true);
});

test('关闭邮件应用后再次打开会重新处理清理', () => {
    const worker = createWorker();
    worker.newEmailCounts.set('a@example.com', 1);

    worker.notifyMailboxOpened();
    worker.notifyMailboxClosed();
    worker.newEmailCounts.set('a@example.com', 4);
    worker.notifyMailboxOpened();

    assert.equal(worker.events.length, 2);
});

test('打开邮件应用且没有新邮件时不产生任何事件', async () => {
    const worker = createWorker();

    worker.notifyMailboxOpened();
    await worker.switchAccount('a@example.com');

    assert.equal(worker.events.length, 0, '打开应用与切换账号都不应触发事件型待办');
});

/**
 * 让 sync() 走 POP3 分支并返回固定的新邮件数量，避免真实网络请求。
 */
function prepareSyncWorker(newEmails) {
    const worker = createWorker();
    worker.syncStatus = {
        isSyncing: false,
        currentProfileId: null,
        lastSyncTime: null,
        lastSyncResults: {},
        syncStartTime: null
    };
    worker.imapBoxCache = new Map();
    worker.resolveInboxProtocol = () => 'pop3';
    worker.syncPOP3Inbox = async () => newEmails;
    return worker;
}

const countEvents = (worker, eventName) => worker.events.filter((e) => e.eventName === eventName).length;

test('正在查看该账号时收到新邮件：派发事件但不累加未读计数', async () => {
    const worker = prepareSyncWorker(2);
    worker.isMailboxOpened = true;
    worker.currentProfileId = 'a@example.com';

    await worker.sync();

    assert.equal(countEvents(worker, 'newEmailCountsUpdated'), 1, '新邮件到达必须派发事件');
    assert.equal(worker.getNewEmailCount('a@example.com'), 0, '正在查看时不应给自己记红点');
});

test('未查看该账号时收到新邮件：派发事件并累加未读计数', async () => {
    const worker = prepareSyncWorker(2);
    worker.isMailboxOpened = false;

    await worker.sync();

    assert.equal(countEvents(worker, 'newEmailCountsUpdated'), 1);
    assert.equal(worker.getNewEmailCount('a@example.com'), 2);
});

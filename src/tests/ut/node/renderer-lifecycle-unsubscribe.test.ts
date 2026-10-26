import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractClasses, extractMethodBody, tryExtractMethodBody } from './fixtures/sourceText.js';

/**
 * 生命周期契约（结构断言）：agentinput.js 里的每个自定义元素类，
 * 在 connectedCallback 中保存的每个订阅句柄字段，都必须在 disconnectedCallback 里退订；
 * 且退订要发生在可能抛错的清理动作（草稿冲刷、拖拽复位）之前，否则异常会跳过退订。
 *
 * 消费端具体接哪个 API 由行为测试覆盖（见 taskview-subscription-release.test.ts 等），
 * 这里只守「句柄有没有被释放」这条不变量。
 */

const source = readFileSync(new URL('../../../renderer/components/agentinput.js', import.meta.url), 'utf8');
const notificationSource = readFileSync(
    new URL('../../../renderer/components/notification.js', import.meta.url),
    'utf8'
);

const classes = extractClasses(source);
const trackedClasses = ['AgentInput', 'ApplicationAgentInput', 'MessageQueuePanel'];

test('三个自定义元素类都能被解析出 connectedCallback / disconnectedCallback', () => {
    for (const name of trackedClasses) {
        const classBlock = classes.get(name);
        assert.ok(classBlock !== undefined, `${name} 未找到`);
        assert.ok(tryExtractMethodBody(classBlock, 'connectedCallback') !== null, `${name} 缺少 connectedCallback`);
        assert.ok(
            tryExtractMethodBody(classBlock, 'disconnectedCallback') !== null,
            `${name} 缺少 disconnectedCallback`
        );
    }
});

test('connectedCallback 中保存的每个订阅句柄都在 disconnectedCallback 中退订', () => {
    for (const name of trackedClasses) {
        const classBlock = classes.get(name)!;
        const connected = tryExtractMethodBody(classBlock, 'connectedCallback') ?? '';
        const disconnected = tryExtractMethodBody(classBlock, 'disconnectedCallback') ?? '';

        const assigned = new Set([...connected.matchAll(/this\.(_unsub\w+)\s*=/g)].map((m) => m[1]));
        const released = new Set([...disconnected.matchAll(/this\.(_unsub\w+)\?\.\(\)/g)].map((m) => m[1]));

        for (const field of assigned) {
            assert.ok(released.has(field), `${name} 的 ${field} 未在 disconnectedCallback 中退订`);
        }
    }
});

test('退订发生在可能抛错的清理动作之前', () => {
    const riskyCalls = ['this.getCurrentText(', 'this._saveDraftNow(', 'this._resetDrag('];

    for (const name of trackedClasses) {
        const classBlock = classes.get(name)!;
        const disconnected = tryExtractMethodBody(classBlock, 'disconnectedCallback') ?? '';
        const releaseIndex = disconnected.search(/this\._unsub\w+\?\.\(\)/);
        if (releaseIndex < 0) continue;

        for (const call of riskyCalls) {
            const callIndex = disconnected.indexOf(call);
            if (callIndex < 0) continue;
            assert.ok(releaseIndex < callIndex, `${name} 的退订必须早于 ${call}（该调用抛错会跳过退订）`);
        }
    }
});

test('异步订阅统一走 adoptDeferredSubscription / subscribePluginSlashCommands，不手写 then 保存句柄', () => {
    const notificationClass = extractClasses(notificationSource).get('NotificationPanel');
    assert.ok(notificationClass !== undefined, 'notification.js 未找到 NotificationPanel');

    const connected = extractMethodBody(notificationClass, 'connectedCallback');
    assert.match(connected, /adoptDeferredSubscription\(\s*this,/, 'notification 的订阅应走 adoptDeferredSubscription');
    assert.ok(!/\.then\(/.test(connected), '不应手写 then 保存句柄（元素可能在等待期间断开）');

    assert.match(
        source,
        /subscribePluginSlashCommands\(\s*this,/,
        'agentinput.js 的插件命令订阅应走 subscribePluginSlashCommands'
    );
});

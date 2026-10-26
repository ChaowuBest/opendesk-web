import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * preload 侧接线：renderer 里「多消费者共享同一通道」的订阅都必须走
 * createIpcChannelDispatcher，不允许再出现 removeAllListeners 式清理（issue #116）。
 *
 * 消费端（谁保存了句柄、谁在断开时退订）由 renderer-lifecycle-unsubscribe.test.ts 与
 * taskview-subscription-release.test.ts 覆盖，这里只钉 preload 这一侧。
 */

const preloadSource = readFileSync(new URL('../../../renderer/preload.js', import.meta.url), 'utf8');

test('mode 与 notification 通道走 dispatcher，且不再用 removeAllListeners 清理', () => {
    assert.match(preloadSource, /createIpcChannelDispatcher\(ipcRenderer, 'mode:changed'\)/);
    assert.match(preloadSource, /createIpcChannelDispatcher\(ipcRenderer, 'mode:taskModeChanged'\)/);
    assert.match(preloadSource, /createIpcChannelDispatcher\(ipcRenderer, 'notification:notificationReceived'\)/);

    assert.ok(
        !/removeAllListeners\('mode:/.test(preloadSource),
        'mode 通道不得用 removeAllListeners 清理（否则后挂载的 AgentInput 会顶掉先前的）'
    );
    assert.ok(!/removeAllListeners\('notification:/.test(preloadSource));
});

test('preload 只剩下通道唯一的 removeAllListeners（taskManager 订阅 id 每次唯一）', () => {
    const removeAllCalls = [...preloadSource.matchAll(/ipcRenderer\.removeAllListeners\(\s*[`']([^`']+)/g)].map(
        (match) => match[1]
    );
    assert.deepEqual(
        removeAllCalls,
        ['taskManager:taskUpdate:${subscriptionId}'],
        '除 per-subscription 唯一通道外，preload 不应再使用 removeAllListeners'
    );
});

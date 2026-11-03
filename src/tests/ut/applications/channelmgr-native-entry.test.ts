import {
    createNativeChannelPluginEntry,
    isNativeChannelEntry,
    type NativeChannelHostDeps
} from '../../../main/applications/channelmgr/native-channel.js';
import type { Channel } from '../../../../packages/plugin-sdk/src/index.js';
import type { ChannelPlugin } from '../../../main/applications/channelmgr/types.js';

function makeChannel(): Channel {
    return {
        meta: { id: 'demo', label: { en: 'Demo', zh: '示例' }, description: 'demo channel' },
        capabilities: { chatTypes: ['direct'] }
    } as unknown as Channel;
}

const deps: NativeChannelHostDeps = {
    getConfig: () => ({}),
    dispatch: async () => {},
    dispatchInteraction: async () => {},
    setStatus: () => {},
    emit: () => {}
};

describe('原生渠道条目', () => {
    test('createNativeChannelPluginEntry 只承载渠道适配器，不再伪造插件 manifest/installRecord', () => {
        const entry = createNativeChannelPluginEntry(makeChannel(), deps);

        expect(Object.keys(entry).sort()).toEqual(['channelPlugin', 'id']);
        expect(entry.id).toBe('demo');
        expect(entry.channelPlugin.id).toBe('demo');
        expect(entry.channelPlugin.meta.label).toBe('Demo');
        expect(isNativeChannelEntry(entry)).toBe(true);
    });

    test('isNativeChannelEntry 只识别原生适配器', () => {
        expect(isNativeChannelEntry({ id: 'x', channelPlugin: {} as ChannelPlugin })).toBe(false);
    });
});

import { mergeMcpRegistryTabState } from '../../../main/applications/mcpmgr/renderer/registry-tabs.js';

describe('mcpmgr renderer registry tabs', () => {
    test('停用当前 registry 时清理搜索状态并回退到已安装页', () => {
        const tabs = [
            { id: 'matrix', label: 'Matrix', icon: '◇' },
            { id: 'clawhub', label: 'ClawHub', icon: '🐾' }
        ];
        const state = {
            query: 'fetch',
            results: [{ id: 'stale-entry' }],
            total: 1,
            page: 2,
            hasMore: true,
            searching: true,
            loadingMore: true,
            hasSearched: true,
            message: { text: 'stale', isError: true }
        };

        const result = mergeMcpRegistryTabState(tabs, state, 'clawhub', [{ id: 'matrix', label: 'Matrix', icon: '◇' }]);

        expect(result).toEqual({ removedIds: ['clawhub'], activeTab: 'installed' });
        expect(tabs.map((tab) => tab.id)).toEqual(['matrix']);
        expect(state).toEqual({
            query: '',
            results: [],
            total: 0,
            page: 1,
            hasMore: false,
            searching: false,
            loadingMore: false,
            hasSearched: false,
            message: null
        });
    });

    test('刷新快照时保留仍启用的 registry，并更新 tab 元数据', () => {
        const tabs = [{ id: 'matrix', label: 'Old label', icon: 'old' }];
        const state = {
            query: '',
            results: [],
            total: 0,
            page: 1,
            hasMore: false,
            searching: false,
            loadingMore: false,
            hasSearched: false,
            message: null
        };

        const result = mergeMcpRegistryTabState(tabs, state, 'matrix', [
            { id: 'matrix', label: 'Matrix MCPs', icon: '◇' },
            { id: 'modelscope-mcp', label: 'ModelScope MCP', icon: '◈' }
        ]);

        expect(result).toEqual({ removedIds: [], activeTab: 'matrix' });
        expect(tabs).toEqual([
            { id: 'matrix', label: 'Matrix MCPs', icon: '◇' },
            { id: 'modelscope-mcp', label: 'ModelScope MCP', icon: '◈' }
        ]);
    });
});

import fs from 'fs';
import { describe, expect, test } from '@jest/globals';

const source = fs.readFileSync(
    new URL('../../../main/applications/skillmgr/renderer/entry.js', import.meta.url),
    'utf8'
);

describe('技能详情弹窗的就地更新路径', () => {
    test('_renderDetailModal 复用 existingCard 时不得先移除弹窗', () => {
        // 回归：此前无条件先 _removeDetailModal()（移除 #detail-overlay）再判
        // existingCard.isConnected，复用分支永远不可达，懒加载工具就绪后的
        // 就地更新退化为整弹窗重建、入场动画重播
        expect(source).toContain('if (!existingCard?.isConnected) {');
        // 就地更新调用确实传入了已打开的弹窗实例
        expect(source).toContain(
            'this._renderDetailModal({ ...detail, tools: mergedTools }, { isBuiltin: true }, card)'
        );
    });
});

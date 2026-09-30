import { zhCn } from '../../../main/applications/terminal/locale/zh-cn.js';
import { enUs } from '../../../main/applications/terminal/locale/en-us.js';

function keyDiff(a: Record<string, string>, b: Record<string, string>): string[] {
    const missingInB = Object.keys(a).filter((k) => !(k in b));
    const missingInA = Object.keys(b).filter((k) => !(k in a));
    return [...missingInB, ...missingInA];
}

describe('terminal locale', () => {
    test('zh-CN and en-US dictionaries have identical key sets', () => {
        expect(keyDiff(zhCn, enUs)).toEqual([]);
    });

    test('sandbox hints exist in both languages and stay actionable', () => {
        for (const dictionary of [zhCn, enUs]) {
            // 路径提示：宿主盘符路径在沙箱内直接可用（Detours 语义）
            expect(dictionary['sandbox.pathErrorHint']).toMatch(/host drive paths|宿主盘符路径/i);
            // 管道提示：普通令牌下命名管道可用（无 AppContainer 限制）
            expect(dictionary['sandbox.pipeErrorHint']).toMatch(/named pipes|命名管道/);
        }
    });
});

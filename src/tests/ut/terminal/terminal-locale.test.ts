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
            // 路径提示必须给出根相对路径的改写方向
            expect(dictionary['sandbox.pathErrorHint']).toContain('/C/');
            // 管道提示必须给出可行动的等价命令
            expect(dictionary['sandbox.pipeErrorHint']).toContain('node --import tsx');
        }
    });
});

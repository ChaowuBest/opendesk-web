import { truncateTaskName } from '../../../main/utils/task-name.js';

// 检测被截半的孤立代理项（乱码）：高代理后无低代理，或低代理前无高代理
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

describe('truncateTaskName', () => {
    test('30 字符以内的消息折叠空白后原样返回', () => {
        expect(truncateTaskName('帮我修复登录页面的按钮错位问题')).toBe('帮我修复登录页面的按钮错位问题');
    });

    test('恰好 30 字符不添加省略号', () => {
        const message = '一'.repeat(30);
        expect(truncateTaskName(message)).toBe(message);
    });

    test('超过 30 字符按码点截断并追加省略号', () => {
        const message = '一'.repeat(31);
        expect(truncateTaskName(message)).toBe('一'.repeat(30) + '...');
    });

    test('按 Unicode 码点截断，不把 emoji 代理对截半产生乱码', () => {
        // 第 30 个 UTF-16 code unit 恰好落在 emoji 代理对的高位上，
        // 若按 code unit 截断会产生孤立高代理（乱码）
        const message = 'A'.repeat(29) + '🌏' + '数据分析报告';
        const name = truncateTaskName(message);
        expect(name).toBe('A'.repeat(29) + '🌏' + '...');
        expect(name.match(LONE_SURROGATE)).toBeNull();
    });

    test('连续空白折叠为单个空格', () => {
        expect(truncateTaskName('修复\n\n登录\t\tbug   问题')).toBe('修复 登录 bug 问题');
    });

    test('首尾空白被裁剪', () => {
        expect(truncateTaskName('  hello world  ')).toBe('hello world');
    });

    test('截断点落在空白上时先裁掉尾部空白再加省略号', () => {
        const message = 'a'.repeat(29) + ' ' + 'b'.repeat(10);
        expect(truncateTaskName(message)).toBe('a'.repeat(29) + '...');
    });

    test('空白消息折叠为空字符串', () => {
        expect(truncateTaskName('   ')).toBe('');
    });
});

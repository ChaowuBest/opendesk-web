import { normalizeGeneratedTaskName, TASK_NAME_MAX_LENGTH, truncateTaskName } from '../../../main/utils/task-name.js';

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

    test('截断点落在 emoji 组合符上时不留下孤立 ZWJ', () => {
        // 第 30 个码点落在 👨‍👩‍👧 的 ZWJ 上，若直接拼省略号会得到 "👨‍..." 这种残片
        const message = 'A'.repeat(28) + '👨‍👩‍👧 旅行计划';
        const name = truncateTaskName(message);
        expect(name).toBe('A'.repeat(28) + '👨' + '...');
    });

    test('截断后只剩组合符时返回空串而不是裸省略号', () => {
        expect(truncateTaskName('\u200D'.repeat(TASK_NAME_MAX_LENGTH + 1))).toBe('');
    });

    test('控制字符、零宽字符与双向控制符被剔除', () => {
        expect(truncateTaskName('修复\u200B登录\u202Ebug')).toBe('修复登录bug');
        expect(truncateTaskName('a\u0000b\u2060c')).toBe('abc');
        // ZWJ 保留，避免打散 emoji 组合序列与连字
        expect(truncateTaskName('👨‍👩‍👧 旅行计划')).toBe('👨‍👩‍👧 旅行计划');
    });

    test('空白消息折叠为空字符串', () => {
        expect(truncateTaskName('   ')).toBe('');
        expect(truncateTaskName('\u200B\uFEFF')).toBe('');
    });
});

describe('normalizeGeneratedTaskName', () => {
    test('正常的模型生成名原样返回', () => {
        expect(normalizeGeneratedTaskName('修复登录bug')).toBe('修复登录bug');
        expect(normalizeGeneratedTaskName('Fix login bug')).toBe('Fix login bug');
        expect(normalizeGeneratedTaskName('PR#684 代码审查')).toBe('PR#684 代码审查');
    });

    test('空值与空白返回 null', () => {
        expect(normalizeGeneratedTaskName('')).toBeNull();
        expect(normalizeGeneratedTaskName('   ')).toBeNull();
        expect(normalizeGeneratedTaskName(null)).toBeNull();
        expect(normalizeGeneratedTaskName(undefined)).toBeNull();
    });

    test('花括号包裹的模板占位符返回 null', () => {
        expect(normalizeGeneratedTaskName('{generated_task_name}')).toBeNull();
        expect(normalizeGeneratedTaskName('{生成的任务名}')).toBeNull();
        expect(normalizeGeneratedTaskName('  { task_name }  ')).toBeNull();
        expect(normalizeGeneratedTaskName('｛generated_task_name｝')).toBeNull();
    });

    test('花括号内是真实名称时保留', () => {
        // 内部含空格说明是真实名称而不是单段占位模板
        expect(normalizeGeneratedTaskName('{ctx} 与 {env} 命名冲突')).toBe('{ctx} 与 {env} 命名冲突');
        expect(normalizeGeneratedTaskName('{name: string} 类型收窄')).toBe('{name: string} 类型收窄');
    });

    test('占位符字面量及其包裹转写返回 null', () => {
        expect(normalizeGeneratedTaskName('generated_task_name')).toBeNull();
        expect(normalizeGeneratedTaskName('generatedTaskName')).toBeNull();
        expect(normalizeGeneratedTaskName('generated-task-name')).toBeNull();
        // 只写了左花括号也算占位符转写
        expect(normalizeGeneratedTaskName('{generated_task_name')).toBeNull();
        expect(normalizeGeneratedTaskName('task_name')).toBeNull();
        expect(normalizeGeneratedTaskName('taskname')).toBeNull();
        // prompt 里 <taskname>任务名称</taskname> 的占位文字被照抄时同样不可用，
        // 包括模型自己加上引号/括号/markdown 强调的转写
        expect(normalizeGeneratedTaskName('任务名称')).toBeNull();
        expect(normalizeGeneratedTaskName(' 任务 名称 ')).toBeNull();
        expect(normalizeGeneratedTaskName('"任务名称"')).toBeNull();
        expect(normalizeGeneratedTaskName('「任务名称」')).toBeNull();
        expect(normalizeGeneratedTaskName('**任务名称**')).toBeNull();
    });

    test('占位标签被当成标题前缀复读时剥掉前缀', () => {
        expect(normalizeGeneratedTaskName('任务名称：修复登录')).toBe('修复登录');
        expect(normalizeGeneratedTaskName('任务名称: 修复登录')).toBe('修复登录');
        expect(normalizeGeneratedTaskName('子任务标题 - 重构解析器')).toBe('重构解析器');
        expect(normalizeGeneratedTaskName('子任务标题——排查内存泄漏')).toBe('排查内存泄漏');
        expect(normalizeGeneratedTaskName(' 任务名称 ： 修复登录 ')).toBe('修复登录');
        // 连续复读时逐层剥掉
        expect(normalizeGeneratedTaskName('任务名称：子任务标题：修复登录')).toBe('修复登录');
        // 只写了标签和分隔符时没有可用内容
        expect(normalizeGeneratedTaskName('任务名称：')).toBeNull();
        expect(normalizeGeneratedTaskName('子任务标题 - ')).toBeNull();
        // 剥完只剩占位符本身或纯符号时同样不可用
        expect(normalizeGeneratedTaskName('任务名称：{子任务标题}')).toBeNull();
        expect(normalizeGeneratedTaskName('任务名称：...')).toBeNull();
        // 裸标签（没有分隔符）也是占位符，不能当成任务名
        expect(normalizeGeneratedTaskName('子任务标题')).toBeNull();
        expect(normalizeGeneratedTaskName(' 子任务标题 ')).toBeNull();
        expect(normalizeGeneratedTaskName('「子任务标题」')).toBeNull();
        expect(normalizeGeneratedTaskName('任务名称：子任务标题')).toBeNull();
        // 无分隔符或标签在中间时不剥，避免破坏真实名字
        expect(normalizeGeneratedTaskName('任务名称修复登录')).toBe('任务名称修复登录');
        expect(normalizeGeneratedTaskName('修复任务名称的展示')).toBe('修复任务名称的展示');
    });

    test('纯符号与省略号返回 null', () => {
        expect(normalizeGeneratedTaskName('...')).toBeNull();
        expect(normalizeGeneratedTaskName('…')).toBeNull();
        expect(normalizeGeneratedTaskName('---')).toBeNull();
        expect(normalizeGeneratedTaskName('。')).toBeNull();
    });

    test('残留标签返回 null', () => {
        expect(normalizeGeneratedTaskName('<taskname>')).toBeNull();
        expect(normalizeGeneratedTaskName('</taskname> 修复登录')).toBeNull();
        expect(normalizeGeneratedTaskName('<TaskName>修复登录')).toBeNull();
    });

    test('控制字符与双向控制符被剔除', () => {
        expect(normalizeGeneratedTaskName('修复\u200B登录\u202Ebug')).toBe('修复登录bug');
        expect(normalizeGeneratedTaskName('a\u0000b')).toBe('ab');
        expect(normalizeGeneratedTaskName('\u200B')).toBeNull();
        // ZWJ 保留，避免打散 emoji 组合序列
        expect(normalizeGeneratedTaskName('👨‍👩‍👧 旅行计划')).toBe('👨‍👩‍👧 旅行计划');
    });

    test('含符号但仍有实义字符的名称可用', () => {
        expect(normalizeGeneratedTaskName('修复登录…问题')).toBe('修复登录…问题');
        expect(normalizeGeneratedTaskName('0.3.9 发布说明')).toBe('0.3.9 发布说明');
    });

    test('可用名称折叠空白并截断到统一长度', () => {
        expect(normalizeGeneratedTaskName('  修复\n登录\t\tbug  ')).toBe('修复 登录 bug');
        const longName = '修复登录页面的按钮错位问题并补充对应的单元测试与回归验证覆盖以及文档更新';
        expect(normalizeGeneratedTaskName(longName)).toBe(
            Array.from(longName).slice(0, TASK_NAME_MAX_LENGTH).join('') + '...'
        );
    });

    test('不会返回空串：截断后为空也算不可用', () => {
        // 前 30 个码点全是 ZWJ，截断后会被裁空；返回值必须落到 null 而不是空串，
        // 否则调用方的 `?? 回退名` 接不住，会把空名写进 task_name
        expect(normalizeGeneratedTaskName('\u200D'.repeat(TASK_NAME_MAX_LENGTH) + 'A')).toBeNull();
    });
});

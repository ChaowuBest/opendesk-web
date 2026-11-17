import { jest } from '@jest/globals';
import { LLM } from '../../../main/aikernel/llm.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { TASK_NAME_MAX_LENGTH, TASK_NAME_PROMPT_PLACEHOLDER } from '../../../main/utils/task-name.js';
import { Setting } from '../../../main/utils/setting.js';
import { setRuntimeLocale } from '../../../locale/index.js';

function configureModels(models: string[] = ['mock-a'], defaultModel = 'mock-a'): void {
    Setting.updateInstanceData({
        default_model: defaultModel,
        providers: [
            {
                name: 'mock-provider',
                provider_type: 'openai',
                base_url: 'https://mock.local/v1',
                api_key: 'test-key',
                no_proxy: true
            }
        ],
        models: models.map((alias) => ({
            alias,
            provider_name: 'mock-provider',
            model_name: `mock/${alias}`
        }))
    });
}

function createTask(): TaskState {
    const task = new TaskState(new TaskManagerState());
    task.task_name = '未命名任务';
    return task;
}

// 检测被截半的孤立代理项（乱码）：高代理后无低代理，或低代理前无高代理
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

describe('generateTaskName 输出解析鲁棒性', () => {
    beforeEach(() => {
        configureModels();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        Setting.clearCache();
    });

    test('标准单行 <taskname> 输出被正确提取', async () => {
        jest.spyOn(LLM, 'ask').mockResolvedValue('<taskname>修复登录bug</taskname>');
        const task = createTask();

        await task.generateTaskName('帮我修复登录页面的按钮错位问题');

        expect(task.task_name).toBe('修复登录bug');
    });

    test('思维链混在输出中时仍能通过标签提取任务名', async () => {
        jest.spyOn(LLM, 'ask').mockResolvedValue(
            '用户想要修复登录 bug，这属于身份验证模块的问题，我需要给任务起一个简短的名字。\n<taskname>修复登录bug</taskname>'
        );
        const task = createTask();

        await task.generateTaskName('帮我修复登录页面的按钮错位问题');

        expect(task.task_name).toBe('修复登录bug');
    });

    test('标签后跟随额外说明文本时只提取标签内容', async () => {
        jest.spyOn(LLM, 'ask').mockResolvedValue('<taskname>重构解析器</taskname>\n以上就是我为这个任务生成的名称。');
        const task = createTask();

        await task.generateTaskName('把解析器重构成模块化结构');

        expect(task.task_name).toBe('重构解析器');
    });

    test('标签内容含换行时折叠为单行空白', async () => {
        jest.spyOn(LLM, 'ask').mockResolvedValue('<taskname>修复\n登录bug</taskname>');
        const task = createTask();

        await task.generateTaskName('帮我修复登录页面的按钮错位问题');

        expect(task.task_name).toBe('修复 登录bug');
    });

    test('标签内容含连续空白时折叠为单个空格', async () => {
        jest.spyOn(LLM, 'ask').mockResolvedValue('<taskname>修复\t\t登录   bug</taskname>');
        const task = createTask();

        await task.generateTaskName('帮我修复登录页面的按钮错位问题');

        expect(task.task_name).toBe('修复 登录 bug');
    });

    test('输出无标签时回退为用户消息前 30 个字符', async () => {
        jest.spyOn(LLM, 'ask').mockResolvedValue('这个任务的名字应该是：重构解析器相关内容');
        const task = createTask();
        const message = '帮我重构解析器并补充单元测试覆盖，确保重构后的行为与原有实现完全一致';

        await task.generateTaskName(message);

        expect(task.task_name).toBe(Array.from(message).slice(0, 30).join('') + '...');
    });

    test('回退截断汉字时不会产生乱码', async () => {
        jest.spyOn(LLM, 'ask').mockResolvedValue('');
        const task = createTask();
        const message = '这是一段很长很长的用户输入内容需要被截断成任务名称并且包含足够多的字符用于验证截断行为';

        await task.generateTaskName(message);

        expect(task.task_name).toBe(Array.from(message).slice(0, 30).join('') + '...');
        // 每个字符都应是完整的 Unicode 码点，不含被截半的孤立代理项
        expect(task.task_name.match(LONE_SURROGATE)).toBeNull();
    });

    test('回退截断含 emoji 的消息时按码点截断不拆散代理对', async () => {
        jest.spyOn(LLM, 'ask').mockResolvedValue('无法解析的输出');
        const task = createTask();
        // 第 30 个 UTF-16 code unit 恰好落在 emoji 代理对的高位上，
        // 若按 code unit 截断会产生孤立高代理（乱码）
        const message = 'A'.repeat(29) + '🌏数据分析报告';

        await task.generateTaskName(message);

        expect(task.task_name).toBe('A'.repeat(29) + '🌏...');
        expect(task.task_name.match(LONE_SURROGATE)).toBeNull();
    });

    test('标签内容为空白时回退为用户消息前 30 个字符', async () => {
        jest.spyOn(LLM, 'ask').mockResolvedValue('<taskname>   </taskname>');
        const task = createTask();
        const message = '导出任务列表为 JSON 并按时间倒序排列展示前一百条完整记录';

        await task.generateTaskName(message);

        expect(task.task_name).toBe(Array.from(message).slice(0, 30).join('') + '...');
    });

    test('LLM 调用失败时回退为用户消息前 30 个字符', async () => {
        jest.spyOn(LLM, 'ask').mockRejectedValue(new Error('network error'));
        const task = createTask();
        const message = '帮我修复登录页面的按钮错位问题并补充对应的单元测试与回归验证覆盖';

        await task.generateTaskName(message);

        expect(task.task_name).toBe(Array.from(message).slice(0, 30).join('') + '...');
    });

    test('用户消息为空时不请求模型，保留原任务名', async () => {
        const ask = jest.spyOn(LLM, 'ask').mockResolvedValue('<taskname>{生成的任务名}</taskname>');
        const task = createTask();
        // 用一个非默认名，确认早退分支只是"不覆盖"，而不是重新写回同名占位
        task.task_name = '已有名字';

        await task.generateTaskName('');

        // 空输入没有可命名的内容，模型只会复读模板，因此直接跳过请求
        expect(ask).not.toHaveBeenCalled();
        expect(task.task_name).toBe('已有名字');
    });

    test('用户消息只含空白、零宽字符或控制字符时同样不请求模型', async () => {
        const ask = jest.spyOn(LLM, 'ask').mockResolvedValue(`<taskname>${TASK_NAME_PROMPT_PLACEHOLDER}</taskname>`);
        const task = createTask();
        task.task_name = '已有名字';

        await task.generateTaskName('   ');
        // 纯图片消息夹带零宽字符、粘贴终端文本夹带 ESC 序列
        await task.generateTaskName('\u200B\uFEFF');
        await task.generateTaskName('\u0000\u001B');

        expect(ask).not.toHaveBeenCalled();
        expect(task.task_name).toBe('已有名字');
    });

    test('模型回显 prompt 占位符时回退为用户消息截断', async () => {
        jest.spyOn(LLM, 'ask').mockResolvedValue('<taskname>{generated_task_name}</taskname>');
        const task = createTask();
        const message = '帮我修复登录页面的按钮错位问题';

        await task.generateTaskName(message);

        expect(task.task_name).toBe(message);
    });

    test('模型照抄 prompt 里的格式占位文本时回退为用户消息截断', async () => {
        jest.spyOn(LLM, 'ask').mockResolvedValue(`<taskname>${TASK_NAME_PROMPT_PLACEHOLDER}</taskname>`);
        const task = createTask();
        const message = '帮我修复登录页面的按钮错位问题';

        await task.generateTaskName(message);

        expect(task.task_name).toBe(message);
    });

    test('模型给占位文本加上引号时同样回退为用户消息截断', async () => {
        jest.spyOn(LLM, 'ask').mockResolvedValue(`<taskname>"${TASK_NAME_PROMPT_PLACEHOLDER}"</taskname>`);
        const task = createTask();
        const message = '帮我修复登录页面的按钮错位问题';

        await task.generateTaskName(message);

        expect(task.task_name).toBe(message);
    });

    test('模型输出大写标签时仍能提取任务名', async () => {
        jest.spyOn(LLM, 'ask').mockResolvedValue('<TaskName>修复登录bug</TaskName>');
        const task = createTask();

        await task.generateTaskName('帮我修复登录页面的按钮错位问题');

        expect(task.task_name).toBe('修复登录bug');
    });

    test('模型只输出省略号时回退为用户消息截断', async () => {
        jest.spyOn(LLM, 'ask').mockResolvedValue('<taskname>...</taskname>');
        const task = createTask();
        const message = '帮我修复登录页面的按钮错位问题';

        await task.generateTaskName(message);

        expect(task.task_name).toBe(message);
    });

    test('模型输出的超长名称截断到统一长度', async () => {
        const longName = '修复登录页面的按钮错位问题并补充对应的单元测试与回归验证覆盖以及文档更新';
        jest.spyOn(LLM, 'ask').mockResolvedValue(`<taskname>${longName}</taskname>`);
        const task = createTask();

        await task.generateTaskName('帮我修复登录页面的按钮错位问题');

        expect(task.task_name).toBe(Array.from(longName).slice(0, TASK_NAME_MAX_LENGTH).join('') + '...');
    });

    test('prompt 要求模型输出单行 taskname 标签格式', async () => {
        const ask = jest.spyOn(LLM, 'ask').mockResolvedValue('<taskname>修复登录bug</taskname>');
        const task = createTask();

        await task.generateTaskName('帮我修复登录页面的按钮错位问题');

        const prompt = ask.mock.calls[0][0] as string;
        expect(prompt).toContain('<taskname>');
        expect(prompt).toContain('</taskname>');
        expect(prompt).toContain('单行');
        // prompt 不能用带花括号的模板占位符做格式示例，否则模型会原样抄回来
        expect(prompt).not.toContain('<taskname>{');
        // 格式占位文本必须取自 normalizeGeneratedTaskName 的同名常量，保证判定规则跟随 prompt 措辞
        expect(prompt).toContain(`<taskname>${TASK_NAME_PROMPT_PLACEHOLDER}</taskname>`);
    });
});

describe('generateTaskName 任务名语言跟随系统当前语言', () => {
    beforeEach(() => {
        configureModels();
    });

    afterEach(() => {
        setRuntimeLocale(null);
        jest.restoreAllMocks();
        Setting.clearCache();
    });

    test('系统语言为中文时要求输出中文名', async () => {
        setRuntimeLocale('zh-CN');
        const ask = jest.spyOn(LLM, 'ask').mockResolvedValue('<taskname>修复登录bug</taskname>');
        const task = createTask();

        await task.generateTaskName('帮我修复登录页面的按钮错位问题');

        const prompt = ask.mock.calls[0][0] as string;
        expect(prompt).toContain('中文（zh-CN）');
    });

    test('系统语言为英文时要求输出英文名，30 字符以内的名字不被截断', async () => {
        setRuntimeLocale('en-US');
        const ask = jest.spyOn(LLM, 'ask').mockResolvedValue('<taskname>Fix login button misalignment</taskname>');
        const task = createTask();

        await task.generateTaskName('帮我修复登录页面的按钮错位问题');

        const prompt = ask.mock.calls[0][0] as string;
        expect(prompt).toContain('English（en-US）');
        // 长度提示与截断上限的关系由 buildTaskNamePrompt 的单测覆盖，这里只验证端到端不截断
        expect(task.task_name).toBe('Fix login button misalignment');
    });

    test('语言包注册的其它语言按自身展示名要求输出', async () => {
        setRuntimeLocale('de-DE');
        const ask = jest.spyOn(LLM, 'ask').mockResolvedValue('<taskname>Login-Button ausrichten</taskname>');
        const task = createTask();

        await task.generateTaskName('帮我修复登录页面的按钮错位问题');

        const prompt = ask.mock.calls[0][0] as string;
        expect(prompt).toContain('Deutsch（de-DE）');
    });

    test('非中文界面下模型复读英文标签前缀时剥掉前缀', async () => {
        setRuntimeLocale('en-US');
        jest.spyOn(LLM, 'ask').mockResolvedValue('<taskname>Task name: Fix login button misalignment</taskname>');
        const task = createTask();

        await task.generateTaskName('帮我修复登录页面的按钮错位问题');

        expect(task.task_name).toBe('Fix login button misalignment');
    });
});

describe('submitUserMessage 关闭自动命名时使用用户输入作为任务名', () => {
    beforeEach(() => {
        configureModels();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        Setting.clearCache();
    });

    function createSubmittableTask(): TaskState {
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        manager.moveTaskToEnd = jest.fn();
        const task = new TaskState(manager);
        jest.spyOn(task, 'ensureValidModelOrFallback').mockReturnValue('mock-a');
        manager.tasks.push(task);
        return task;
    }

    function disableAutoNaming(): void {
        Setting.updateInstanceData({
            task_config: {
                auto_retry: true,
                generate_taskname: false,
                termination_check: true,
                evidence_card: false
            }
        });
    }

    test('关闭自动生成时任务名为用户输入截断到 30 字符', async () => {
        disableAutoNaming();
        jest.spyOn(LLM, 'ask').mockResolvedValue('<taskname>不应被使用</taskname>');
        const task = createSubmittableTask();
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        jest.spyOn(task, 'processTaskTurn').mockResolvedValue(undefined);

        const message = '帮我修复登录页面的按钮错位问题并补充对应的单元测试与回归验证覆盖';
        await task.submitUserMessage(message);

        expect(task.task_name).toBe(Array.from(message).slice(0, 30).join('') + '...');
        // 关闭自动命名时不触发 LLM 命名请求
        expect(LLM.ask).not.toHaveBeenCalled();
    });

    test('关闭自动命名时按码点截断，emoji 不被截半', async () => {
        disableAutoNaming();
        jest.spyOn(LLM, 'ask').mockResolvedValue('<taskname>不应被使用</taskname>');
        const task = createSubmittableTask();
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        jest.spyOn(task, 'processTaskTurn').mockResolvedValue(undefined);

        // 第 30 个 UTF-16 code unit 恰好落在 emoji 代理对的高位上，
        // 若按 code unit 截断会产生孤立高代理（乱码）
        const message = 'A'.repeat(29) + '🌏数据分析报告';
        await task.submitUserMessage(message);

        expect(task.task_name).toBe('A'.repeat(29) + '🌏...');
        expect(task.task_name!.match(LONE_SURROGATE)).toBeNull();
    });
});

describe('submitUserMessage 自动命名', () => {
    beforeEach(() => {
        // 不额外改 task_config：generate_taskname 未配置时默认开启自动命名
        configureModels();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        Setting.clearCache();
    });

    test('纯图片消息（空文本）不触发命名请求，任务名保留为未命名任务', async () => {
        const ask = jest.spyOn(LLM, 'ask').mockResolvedValue(`<taskname>${TASK_NAME_PROMPT_PLACEHOLDER}</taskname>`);
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        manager.moveTaskToEnd = jest.fn();
        const task = new TaskState(manager);
        jest.spyOn(task, 'ensureValidModelOrFallback').mockReturnValue('mock-a');
        manager.tasks.push(task);
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        jest.spyOn(task, 'processTaskTurn').mockResolvedValue(undefined);

        await task.submitUserMessage('');
        // submitUserMessage 自身在提交时就会持久化并广播一次，
        // 这里要证明的是"命名 promise 的收尾逻辑"也执行了，所以按增量断言
        const saveCount = (manager.save as jest.Mock).mock.calls.length;
        const publishCount = (manager.publishTaskListUpdate as jest.Mock).mock.calls.length;
        // 命名请求是按 promise 异步发起的，等一个 tick 再确认它确实没有发出
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(ask).not.toHaveBeenCalled();
        expect(task.task_name).toBe('未命名任务');
        expect((manager.save as jest.Mock).mock.calls.length).toBeGreaterThan(saveCount);
        expect((manager.publishTaskListUpdate as jest.Mock).mock.calls.length).toBeGreaterThan(publishCount);
    });
});

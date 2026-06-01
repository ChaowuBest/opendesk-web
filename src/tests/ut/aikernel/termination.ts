/**
 * checkTerminationFromMessages 终止性判断测试
 *
 * 运行方式:
 *   npx tsx src/tests/ut/aikernel/termination.ts
 *
 * 前置条件:
 *   需要在 OpenDesk 配置文件中正确配置默认模型（default_model）的 provider 和 api_key，
 *   以便 LLM.ask 能正常调用。
 */

import { checkTerminationFromMessages, fastInterruptionCheck } from '../../../main/aikernel/termination.js';

type TerminationState = 'finished' | 'interrupted' | 'question';

// ============================================================
// fastInterruptionCheck 单元测试（纯函数，不需要 LLM）
// ============================================================

interface FastCheckTestCase {
    description: string;
    lastTextResponse: string;
    expected: 'interrupted' | null;
}

const fastCheckCases: FastCheckTestCase[] = [
    // === 最后子句以"接下来"开头 ===
    {
        description: '最后子句以"接下来"开头',
        lastTextResponse: '我已经完成了文件读取。接下来我将分析代码结构',
        expected: 'interrupted'
    },
    {
        description: '"接下来"不在最后子句开头，不应命中',
        lastTextResponse: '我已经完成了第一步，接下来需要继续第二步。任务已全部完成。',
        expected: null
    },

    // === 最后子句以"让我"开头 ===
    {
        description: '最后子句以"让我"开头',
        lastTextResponse: '好的。让我先搜索相关文档',
        expected: 'interrupted'
    },
    {
        description: '"让我"不在最后子句开头，不应命中',
        lastTextResponse: '如果你让我帮你处理，我会马上开始。任务已完成。',
        expected: null
    },

    // === 以逗号结尾 ===
    {
        description: '中文逗号结尾：明显未完成',
        lastTextResponse: '首先读取配置文件，',
        expected: 'interrupted'
    },
    {
        description: '英文逗号结尾',
        lastTextResponse: 'First, we need to read the config,',
        expected: 'interrupted'
    },

    // === 以冒号结尾 ===
    {
        description: '中文冒号结尾',
        lastTextResponse: '具体步骤如下：',
        expected: 'interrupted'
    },
    {
        description: '英文冒号结尾',
        lastTextResponse: 'Here is the plan:',
        expected: 'interrupted'
    },

    // === 以顿号结尾 ===
    {
        description: '顿号结尾',
        lastTextResponse: '支持 Python、JavaScript、',
        expected: 'interrupted'
    },

    // === 以分号结尾 ===
    {
        description: '中文分号结尾',
        lastTextResponse: '首先初始化变量；',
        expected: 'interrupted'
    },
    {
        description: '英文分号结尾',
        lastTextResponse: 'first init the variable;',
        expected: 'interrupted'
    },

    // === 正常完成的情况 ===
    {
        description: '以句号结尾的完整句子',
        lastTextResponse: '任务已完成，文件已保存到指定目录。',
        expected: null
    },
    {
        description: '以感叹号结尾',
        lastTextResponse: '所有测试均已通过！',
        expected: null
    },
    {
        description: '以问号结尾',
        lastTextResponse: '请确认是否继续执行？',
        expected: null
    },
    {
        description: '空文本不应命中',
        lastTextResponse: '',
        expected: null
    }
];

function runFastCheckTests(): boolean {
    console.log('--- fastInterruptionCheck 测试 ---\n');

    let passed = 0;
    let failed = 0;

    for (let i = 0; i < fastCheckCases.length; i++) {
        const tc = fastCheckCases[i];
        console.log(`${i + 1}. ${tc.description}`);
        console.log(`   输入: ${JSON.stringify(tc.lastTextResponse)}`);
        console.log(`   期望: ${tc.expected}`);

        const result = fastInterruptionCheck(tc.lastTextResponse);
        if (result === tc.expected) {
            console.log(`   实际: ${result} ✅`);
            passed++;
        } else {
            console.log(`   实际: ${result} ❌`);
            failed++;
        }
        console.log();
    }

    console.log(`fastInterruptionCheck 结果: ${passed} 通过, ${failed} 失败 (共 ${fastCheckCases.length} 个)\n`);
    return failed === 0;
}

interface TerminationTestCase {
    /** 测试用例描述 */
    description: string;
    /** 模拟用户的原始问题 */
    userQuestion: string;
    /** 模拟 AI 回复的最后一部分文本 */
    lastTextResponse: string;
    /** 期望的终止状态 */
    expected: TerminationState;
}

const testCases: TerminationTestCase[] = [
    // ========== interrupted 类 ==========
    {
        description: '明显的中断：回复以"继续执行"开头，后续步骤未完成',
        userQuestion: '帮我查找 DeepWiki MCP 服务器的相关信息并总结',
        lastTextResponse: '好的，让我继续执行任务。首先搜索 DeepWiki MCP 服务器的信息。',
        expected: 'interrupted'
    },
    {
        description: '中断：AI 提到"接下来"但没有实际完成',
        userQuestion: '请帮我分析这个项目的依赖关系并生成报告',
        lastTextResponse: '我已经读取了 package.json 文件。接下来我将分析依赖关系图并生成报告。',
        expected: 'interrupted'
    },
    {
        description: '中断：AI 列出了步骤但只完成了第一步',
        userQuestion: '帮我重构 UserService 类，拆分成多个小模块',
        lastTextResponse:
            '重构计划如下：\n1. 提取认证逻辑到 AuthModule ✓\n2. 提取用户配置到 ProfileModule\n3. 提取通知逻辑到 NotificationModule\n\n第一步已完成，正在处理第二步...',
        expected: 'interrupted'
    },

    // ========== finished 类 ==========
    {
        description: '正常完成：给出了完整的回答',
        userQuestion: 'TypeScript 中 interface 和 type 有什么区别？',
        lastTextResponse:
            '总结来说，interface 更适合定义对象结构和类的契约，支持声明合并；type 更灵活，可以定义联合类型、交叉类型等。在大多数场景下两者可以互换使用，但建议优先使用 interface，在需要高级类型操作时使用 type。',
        expected: 'finished'
    },
    {
        description: '正常完成：任务执行完毕并给出总结',
        userQuestion: '帮我把 utils.js 中的 formatDate 函数改成支持时区参数',
        lastTextResponse:
            '修改已完成。我在 formatDate 函数中新增了可选的 timezone 参数，默认使用系统时区。同时更新了相关的单元测试，所有测试均已通过。',
        expected: 'finished'
    },
    {
        description: '正常完成：简短确认性回答',
        userQuestion: '当前的 Node.js 版本是多少？',
        lastTextResponse: '当前 Node.js 版本为 v20.11.0。',
        expected: 'finished'
    },

    // ========== question 类 ==========
    {
        description: '需要更多信息：AI 询问具体需求',
        userQuestion: '帮我优化数据库查询',
        lastTextResponse:
            '我可以帮你优化数据库查询。但我需要更多信息：\n1. 你使用的是哪种数据库（MySQL、PostgreSQL、MongoDB）？\n2. 能否提供具体的慢查询语句？\n3. 当前的数据量大概是多少？',
        expected: 'question'
    },
    {
        description: '需要更多信息：AI 需要确认方向',
        userQuestion: '帮我部署这个应用',
        lastTextResponse:
            '请问你希望部署到哪个平台？我支持 Vercel、AWS、Docker 等多种方式。另外，这个项目是否已经有 Dockerfile 或者部署配置？',
        expected: 'question'
    }
];

async function runTerminationTests(): Promise<boolean> {
    console.log('\n=== 终止性判断 (checkTerminationFromMessages) 测试 ===\n');

    let passed = 0;
    let failed = 0;

    for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i];
        console.log(`${i + 1}. ${tc.description}`);
        console.log(`   期望: ${tc.expected}`);

        try {
            const result = await checkTerminationFromMessages(tc.userQuestion, tc.lastTextResponse);
            if (result === tc.expected) {
                console.log(`   实际: ${result} ✅`);
                passed++;
            } else {
                console.log(`   实际: ${result} ❌`);
                failed++;
            }
        } catch (err) {
            console.log(`   错误: ${err} ❌`);
            failed++;
        }
        console.log();
    }

    console.log(`=== 测试结果: ${passed} 通过, ${failed} 失败 (共 ${testCases.length} 个) ===\n`);
    return failed === 0;
}

async function main() {
    const fastPassed = runFastCheckTests();
    const llmPassed = await runTerminationTests();
    const allPassed = fastPassed && llmPassed;
    process.exit(allPassed ? 0 : 1);
}

main();

import {
    buildVerifyPrompt,
    parseDatasetManifest,
    parseJudgeScore,
    resolveCaseSpec,
    resolveRunStatus,
    slugify,
    toSafeDirName,
    summarizeCases,
    type CaseRunState
} from '../../../main/applications/benchmark/common.js';
import { setRuntimeLocale } from '../../../locale/index.js';

// 错误文案走应用词表，测试里固定语言，避免跟着开发机的系统语言漂
beforeEach(() => {
    setRuntimeLocale('zh-CN');
});

afterEach(() => {
    setRuntimeLocale(null);
});

function makeCase(patch: Partial<CaseRunState>): CaseRunState {
    return {
        key: 'track/case',
        trackId: 'track',
        trackName: 'Track',
        caseId: 'case',
        name: 'case',
        weight: 1,
        status: 'pending',
        score: null,
        ratio: null,
        reason: '',
        error: '',
        runTaskId: null,
        verifyTaskId: null,
        startedAt: null,
        finishedAt: null,
        dir: 'cases/track__case',
        ...patch
    };
}

describe('parseDatasetManifest', () => {
    test('接受字符串数组形式的 tracks', () => {
        const manifest = parseDatasetManifest({
            name: 'WorkBuddy',
            description: '办公与代码',
            homepage: 'https://example.com',
            tracks: ['office', 'code']
        });
        expect(manifest.name).toBe('WorkBuddy');
        expect(manifest.tracks).toEqual([{ name: 'office' }, { name: 'code' }]);
        expect(manifest.homepage).toBe('https://example.com');
    });

    test('接受对象数组并保留 id/description', () => {
        const manifest = parseDatasetManifest({
            name: 'WB',
            tracks: [{ id: 'office', name: 'Office', description: '文档处理' }]
        });
        expect(manifest.tracks[0]).toEqual({ id: 'office', name: 'Office', description: '文档处理' });
    });

    test('缺少 name 或 tracks 时报错', () => {
        expect(() => parseDatasetManifest({ tracks: ['a'] })).toThrow('name');
        expect(() => parseDatasetManifest({ name: 'x', tracks: [] })).toThrow('tracks');
        expect(() => parseDatasetManifest('nope')).toThrow();
    });
});

describe('resolveCaseSpec', () => {
    const files = new Set(['run.md', 'verify.md', 'run-prepare.sh', 'verify-prepare.sh']);
    const hasFile = (relative: string) => files.has(relative);

    test('使用约定文件名与默认权重', () => {
        const spec = resolveCaseSpec('case-a', {}, hasFile);
        expect(spec).toMatchObject({
            caseId: 'case-a',
            name: 'case-a',
            weight: 1,
            runPromptFile: 'run.md',
            verifyPromptFile: 'verify.md',
            runPrepareFile: 'run-prepare.sh',
            verifyPrepareFile: 'verify-prepare.sh'
        });
    });

    test('没有准备脚本时不强制存在', () => {
        const spec = resolveCaseSpec('case-b', { runPrompt: 'run.md', verifyPrompt: 'verify.md' }, (file) =>
            ['run.md', 'verify.md'].includes(file)
        );
        expect(spec.runPrepareFile).toBeNull();
        expect(spec.verifyPrepareFile).toBeNull();
    });

    test('用例分数与超时时间可覆盖', () => {
        const spec = resolveCaseSpec(
            'case-c',
            { name: '用例 C', score: 5, runTimeoutSec: 60, prepareTimeoutSec: 120, verifyTimeoutSec: 90 },
            hasFile
        );
        expect(spec.name).toBe('用例 C');
        expect(spec.weight).toBe(5);
        expect(spec.runTimeoutSec).toBe(60);
        expect(spec.prepareTimeoutSec).toBe(120);
        expect(spec.verifyTimeoutSec).toBe(90);
    });

    test('声明的脚本文件不存在时报错', () => {
        expect(() => resolveCaseSpec('case-d', { runPrepare: 'missing.sh' }, hasFile)).toThrow('missing.sh');
        expect(() => resolveCaseSpec('case-e', { runPrompt: 'nope.md' }, hasFile)).toThrow('nope.md');
    });
});

describe('parseJudgeScore', () => {
    test('读取 0~1 的 score', () => {
        expect(parseJudgeScore('{"score": 0.75, "reason": "通过 3/4"}')).toEqual({ ratio: 0.75, reason: '通过 3/4' });
    });

    test('兼容 0~100 口径', () => {
        expect(parseJudgeScore('{"score": 80}')?.ratio).toBeCloseTo(0.8);
    });

    test('从带说明的文本里抽取 JSON', () => {
        const text = '验证结果如下：\n```json\n{"score": 1, "reason": "全部通过"}\n```\n以上。';
        expect(parseJudgeScore(text)).toEqual({ ratio: 1, reason: '全部通过' });
    });

    test('无有效分数时返回 null', () => {
        expect(parseJudgeScore('完全无结果')).toBeNull();
        expect(parseJudgeScore(undefined)).toBeNull();
        expect(parseJudgeScore({ score: 'abc' })).toBeNull();
    });
});

describe('summarizeCases', () => {
    test('统计各状态数量与加权得分', () => {
        const summary = summarizeCases([
            makeCase({
                key: 'a',
                status: 'done',
                weight: 2,
                score: 1.5,
                ratio: 0.75,
                startedAt: 1000,
                finishedAt: 3000
            }),
            makeCase({ key: 'b', status: 'failed', weight: 1, ratio: 0, startedAt: 0, finishedAt: 0 }),
            makeCase({ key: 'c', status: 'pending', weight: 1 }),
            makeCase({ key: 'd', status: 'verifying', weight: 1 }),
            makeCase({ key: 'e', status: 'stopped', weight: 1 })
        ]);
        expect(summary.total).toBe(5);
        expect(summary.completed).toBe(1);
        expect(summary.failed).toBe(1);
        expect(summary.pending).toBe(1);
        expect(summary.running).toBe(1);
        expect(summary.stopped).toBe(1);
        expect(summary.maxScore).toBe(6);
        expect(summary.totalScore).toBe(1.5);
        expect(summary.avgRatio).toBeCloseTo(0.375);
        expect(summary.avgDurationMs).toBe(2000);
    });
});

describe('resolveRunStatus', () => {
    test('全部用例失败才算整轮失败', () => {
        expect(resolveRunStatus(['failed', 'failed'], false, 2)).toBe('failed');
    });

    test('有用例成功时按完成处理', () => {
        expect(resolveRunStatus(['done', 'failed'], false, 2)).toBe('completed');
        expect(resolveRunStatus(['done'], false, 1)).toBe('completed');
    });

    test('用户停止优先于失败', () => {
        expect(resolveRunStatus(['failed', 'failed'], true, 2)).toBe('stopped');
    });

    test('有用例没跑完时不判整轮失败', () => {
        expect(resolveRunStatus(['failed'], false, 2)).toBe('completed');
        expect(resolveRunStatus([], false, 0)).toBe('completed');
    });
});

describe('buildVerifyPrompt', () => {
    test('追加可解析的评分结果契约', () => {
        const prompt = buildVerifyPrompt(
            '请按 grading 判定。',
            '/tmp/run/cases/x/verify-workspace/.benchmark/result.json'
        );
        expect(prompt).toContain('请按 grading 判定。');
        expect(prompt).toContain('/tmp/run/cases/x/verify-workspace/.benchmark/result.json');
        expect(prompt).toContain('"score"');
    });
});

describe('toSafeDirName', () => {
    test('把 track/case 标识转成安全目录名', () => {
        expect(toSafeDirName('office/drug-inventory')).toBe('office_drug-inventory');
        expect(toSafeDirName('..weird name')).toBe('_weird_name');
        expect(toSafeDirName('')).toBe('case');
    });
});

describe('slugify', () => {
    test('保留中文并替换路径分隔符', () => {
        expect(slugify('WorkBuddy Office/Code')).toBe('WorkBuddy-Office-Code');
        expect(slugify('测评集 A')).toBe('测评集-A');
        expect(slugify('///')).toBe('dataset');
    });
});

describe('错误文案本地化', () => {
    const hasFile = (relative: string) => ['run.md', 'verify.md'].includes(relative);

    test('dataset.json 校验失败按当前语言给文案', () => {
        setRuntimeLocale('en-US');
        expect(() => parseDatasetManifest({ tracks: ['a'] })).toThrow('dataset.json is missing the name field');
        setRuntimeLocale('zh-CN');
        expect(() => parseDatasetManifest({ tracks: ['a'] })).toThrow('dataset.json 缺少 name 字段');
    });

    test('用例文件缺失的错误带参数并按语言切换', () => {
        setRuntimeLocale('en-US');
        expect(() => resolveCaseSpec('c1', { runPrompt: 'nope.md' }, hasFile)).toThrow(
            'Case c1 is missing its run instruction file: nope.md'
        );
        setRuntimeLocale('zh-CN');
        expect(() => resolveCaseSpec('c1', { runPrompt: 'nope.md' }, hasFile)).toThrow(
            '用例 c1 缺少运行任务指令文件：nope.md'
        );
    });
});

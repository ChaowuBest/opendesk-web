/**
 * /feedback 命令测试：任务列表构建函数应排除自动化任务（internal），并与 GUI 口径对齐。
 */

import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';

/** mock 掉命令模块的重依赖，仅测试任务构建逻辑 */
jest.mock('../../../main/utils/logger.js', () => ({
    getLogFilename: () => 'app.log'
}));
jest.mock('../../../main/utils/setting.js', () => ({
    getLogDirectory: () => '/logs',
    getTaskDirectory: () => '/tasks'
}));
jest.mock('../../../platforms/base.js', () => ({
    getPlatform: () => ({ fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }) })
}));
jest.mock('../../../main/utils/feedback.js', () => ({
    submitFeedback: (async () => ({ ok: true })) as any
}));
jest.mock('../../../main/tui/components/feedback.js', () => ({
    FeedbackWidget: class {
        constructor(_ui: unknown, _options: any) {}
        show() {}
    }
}));

import { TASK_OPTION_LIMIT, buildFeedbackTaskOptions } from '../../../main/tui/commands/feedback.js';
import { setRuntimeLocale } from '../../../locale/index.js';

function makeTaskManager(tasks: any[]) {
    return {
        tasks: [...tasks],
        getTask: (id: string) => tasks.find((t) => t.task_id === id)
    };
}

describe('buildFeedbackTaskOptions', () => {
    beforeEach(() => {
        setRuntimeLocale('zh-CN');
    });

    afterEach(() => {
        setRuntimeLocale(null);
    });

    it('排除自动化任务（internal）', () => {
        const tasks = [
            { task_id: 't-user', task_name: '正常任务', internal: undefined, updated_at: 100 },
            { task_id: 't-auto', task_name: '记忆回顾', internal: true, updated_at: 300 },
            { task_id: 't-automatic', task_name: '数字员工', internal: true, updated_at: 200 }
        ];
        const options = buildFeedbackTaskOptions(makeTaskManager(tasks) as any);
        const ids = options.map((t) => t.taskId);
        expect(ids).toEqual(['t-user']);
        expect(ids).not.toContain('t-auto');
        expect(ids).not.toContain('t-automatic');
    });

    it('按活动时间降序排列并限制数量', () => {
        const tasks = Array.from({ length: 15 }, (_, i) => ({
            task_id: `t-${i}`,
            task_name: `任务 ${i}`,
            updated_at: i
        }));
        const options = buildFeedbackTaskOptions(makeTaskManager(tasks) as any);
        expect(options).toHaveLength(TASK_OPTION_LIMIT);
        expect(options[0].taskId).toBe('t-14'); // 最新在前
        expect(options[options.length - 1].taskId).toBe('t-5');
    });

    it('任务名为空时回退为未命名任务', () => {
        const tasks = [{ task_id: 't-x', task_name: '  ', updated_at: 1 }];
        const options = buildFeedbackTaskOptions(makeTaskManager(tasks) as any);
        expect(options[0].name).toBe('未命名任务');
    });

    it('无任务时返回空数组', () => {
        const options = buildFeedbackTaskOptions(makeTaskManager([]) as any);
        expect(options).toEqual([]);
    });
});

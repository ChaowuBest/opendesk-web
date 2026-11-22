import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { AssistantMessage, ToolCall, ToolCallMessagePart } from '../../../main/aikernel/messages.js';
import { forkTask } from '../../../main/aikernel/task/serializer.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { getTaskArtifactDirectory, getTaskDirectory, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

/**
 * 删除任务的产物清理（图片 / 工具结果 / session-memory / legacy 目录）：
 * - 正常删除路径（removeTask / clearAllTasks）必须连带清理 artifacts/<taskId>/ 整棵树；
 * - 扩展 dispose 抛错不得阻断文件清理（cleanup 尽力而为语义）；
 * - 散落任务 json（不在索引中）由 cleanupOldTaskFiles 连同产物一起兜底清理；
 * - fork 的工具结果产物 copy-on-fork：源任务删除后 fork 仍自洽可读。
 */

describe('task artifacts cleanup on delete', () => {
    let directory: string;
    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'od-task-artifacts-cleanup-'));
        setCustomOpendeskDirectory(directory);
        fs.mkdirSync(path.join(directory, 'tasks'), { recursive: true });
    });
    afterEach(() => {
        jest.restoreAllMocks();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(directory, { recursive: true, force: true });
    });

    /** 预置任务的全套落盘产物：artifacts/<id>/ 三类子目录 + legacy tasks/artifacts/<id>_* */
    function plantArtifacts(taskId: string): void {
        const artifactDir = getTaskArtifactDirectory(taskId, true);
        fs.mkdirSync(path.join(artifactDir, 'images'), { recursive: true });
        fs.writeFileSync(path.join(artifactDir, 'images', 'img-hash.png'), 'fake-image-bytes');
        fs.mkdirSync(path.join(artifactDir, 'tool-results'), { recursive: true });
        fs.writeFileSync(path.join(artifactDir, 'tool-results', 'result-1.txt'), 'original tool output');
        fs.mkdirSync(path.join(artifactDir, 'session-memory'), { recursive: true });
        fs.writeFileSync(path.join(artifactDir, 'session-memory', 'session-memory.md'), 'memory');
        // 旧版扁平布局
        const legacyDir = path.join(getTaskDirectory(), 'artifacts', `${taskId}_legacy`);
        fs.mkdirSync(legacyDir, { recursive: true });
        fs.writeFileSync(path.join(legacyDir, 'legacy.bin'), 'legacy');
    }

    function expectArtifactsGone(taskId: string): void {
        expect(fs.existsSync(path.join(getTaskDirectory(), `${taskId}.json`))).toBe(false);
        expect(fs.existsSync(getTaskArtifactDirectory(taskId, false))).toBe(false);
        expect(fs.existsSync(path.join(getTaskDirectory(), 'artifacts', `${taskId}_legacy`))).toBe(false);
    }

    test('removeTask deletes the task json, the whole artifacts tree, and legacy dirs', () => {
        const manager = new TaskManagerState();
        const task = new TaskState(manager);
        task.task_id = 'cleanup-target';
        task.task_name = 'cleanup target';
        manager.tasks.push(task);
        plantArtifacts('cleanup-target');

        const removed = manager.removeTask('cleanup-target');

        expect(removed).toEqual(['cleanup-target']);
        expectArtifactsGone('cleanup-target');
    });

    test('removeTask cleans up child tasks recursively (artifacts included)', () => {
        const manager = new TaskManagerState();
        const parent = new TaskState(manager);
        parent.task_id = 'cleanup-parent';
        manager.tasks.push(parent);
        const child = new TaskState(manager, 'cleanup-parent');
        child.task_id = 'cleanup-child';
        manager.tasks.push(child);
        plantArtifacts('cleanup-parent');
        plantArtifacts('cleanup-child');

        manager.removeTask('cleanup-parent');

        expectArtifactsGone('cleanup-parent');
        expectArtifactsGone('cleanup-child');
    });

    test('a throwing extension dispose does not abort file cleanup', () => {
        const manager = new TaskManagerState();
        const task = new TaskState(manager);
        task.task_id = 'cleanup-dispose-throw';
        manager.tasks.push(task);
        plantArtifacts('cleanup-dispose-throw');
        jest.spyOn(task.extensions, 'notifyLifecycle').mockImplementation((event) => {
            // 只对 dispose 抛错：钉死 cleanup() 对 dispose 通知的隔离；
            // removeTask 会先触发 stop() 的 'stop' 通知，那里不在本次修复范围
            if (event.type === 'dispose') {
                throw new Error('extension disposed with an error');
            }
        });

        expect(() => manager.removeTask('cleanup-dispose-throw')).not.toThrow();
        expectArtifactsGone('cleanup-dispose-throw');
    });

    test('clearAllTasks removes stray task files together with their artifacts', () => {
        // 散落 json（不在索引中的旧文件，例如崩溃残留 / 其他进程写入）：删除时必须
        // 连同 artifacts/<id>/ 一起清掉，否则留下不可恢复也不可引用的孤儿产物目录
        const manager = new TaskManagerState();
        const task = new TaskState(manager);
        task.task_id = 'cleanup-keep';
        manager.tasks.push(task);
        plantArtifacts('cleanup-keep');
        fs.writeFileSync(path.join(getTaskDirectory(), 'stray.json'), JSON.stringify({ task_id: 'stray' }));
        plantArtifacts('stray');

        manager.clearAllTasks();

        expectArtifactsGone('cleanup-keep');
        expectArtifactsGone('stray');
    });

    test('forkTask copies tool-result artifacts into the fork namespace and rewrites paths', () => {
        const manager = new TaskManagerState();
        const source = new TaskState(manager);
        source.task_id = 'fork-source';
        source.task_name = 'fork source';
        source.tool_result_replacement_state = {
            seenIds: new Set(['result-1']),
            replacements: new Map([
                [
                    'result-1',
                    {
                        replacement_text: 'output preview',
                        relative_path: path.join('artifacts', 'fork-source', 'tool-results', 'result-1.txt')
                    }
                ]
            ])
        };
        const assistant = new AssistantMessage();
        const part = new ToolCallMessagePart();
        const compressed = new ToolCall(0, 'call-1', 'browser-screenshot', '{"seq":1}');
        compressed.status = 'success';
        compressed.result = 'output preview';
        compressed.result_storage = {
            result_id: 'result-1',
            storage_version: 1,
            relative_path: path.join('artifacts', 'fork-source', 'tool-results', 'result-1.txt'),
            replacement_text: 'output preview'
        };
        part.push(compressed);
        assistant.content.push(part);
        source.chat_context.appendMessage(assistant);
        manager.tasks.push(source);
        plantArtifacts('fork-source');

        const forked = forkTask(source);

        // 原文已复制到 fork 命名空间且字节一致
        const forkedRelativePath = path.join('artifacts', forked.task_id, 'tool-results', 'result-1.txt');
        expect(fs.readFileSync(path.join(directory, forkedRelativePath), 'utf8')).toBe('original tool output');
        // chat_context 与 replacement_state 的 relative_path 均已改写
        const forkedPart = forked.chat_context.messages[0] as AssistantMessage;
        const forkedCall = (forkedPart.content.find((item) => item.type === 'tool_call') as ToolCallMessagePart)
            .toolcalls[0];
        expect(forkedCall.result_storage?.relative_path).toBe(forkedRelativePath);
        expect(forked.tool_result_replacement_state.replacements.get('result-1')?.relative_path).toBe(
            forkedRelativePath
        );

        // 源任务删除后，fork 引用仍完整可读（自洽）
        source.cleanup();
        expectArtifactsGone('fork-source');
        expect(fs.existsSync(path.join(directory, forkedRelativePath))).toBe(true);
    });

    test('forkTask rewires structured artifact references (preview/microcompact hint/state record)', () => {
        // 新格式：存储层只有结构化预览与相对路径；fork 改写结构化路径字段即可，
        // 模型可见文本在读取时按当前任务命名空间重新渲染
        const manager = new TaskManagerState();
        const source = new TaskState(manager);
        source.task_id = 'hint-source';
        source.task_name = 'hint source';
        const originalArtifact = path.join(directory, 'artifacts', 'hint-source', 'tool-results', 'result-9.txt');
        fs.mkdirSync(path.dirname(originalArtifact), { recursive: true });
        fs.writeFileSync(originalArtifact, 'original output');

        const assistant = new AssistantMessage();
        const part = new ToolCallMessagePart();
        const compressed = new ToolCall(0, 'call-9', 'filemgr-readFile', '{"path":"x.txt"}');
        compressed.status = 'success';
        compressed.result = '输出预览\n\n完整输出已保存至: <placeholder>';
        compressed.result_storage = {
            result_id: 'result-9',
            storage_version: 1,
            relative_path: path.join('artifacts', 'hint-source', 'tool-results', 'result-9.txt'),
            replacement_preview: '输出预览'
        };
        compressed.microcompact = {
            strategy: 'local_clear',
            cleared_at: '2026-01-01T00:00:00.000Z',
            original_chars: 100,
            original_lines: 3
        };
        part.push(compressed);
        assistant.content.push(part);
        source.chat_context.appendMessage(assistant);
        manager.tasks.push(source);
        source.tool_result_replacement_state = {
            seenIds: new Set(['result-9']),
            replacements: new Map([
                [
                    'result-9',
                    {
                        result_id: 'result-9',
                        replacement_preview: '输出预览',
                        relative_path: path.join('artifacts', 'hint-source', 'tool-results', 'result-9.txt')
                    }
                ]
            ])
        };

        const forked = forkTask(source);
        const forkedPart = (forked.chat_context.messages[0] as AssistantMessage).content.find(
            (item) => item.type === 'tool_call'
        ) as ToolCallMessagePart;
        const hintCall = forkedPart.toolcalls[0];
        const forkedRelativePath = path.join('artifacts', forked.task_id, 'tool-results', 'result-9.txt');
        // 结构化路径字段改写到 fork 命名空间（microcompact 复用 result_storage.relative_path，
        // 不再单独保存产物路径）
        expect(hintCall.result_storage?.relative_path).toBe(forkedRelativePath);
        expect(forked.tool_result_replacement_state.replacements.get('result-9')?.relative_path).toBe(
            forkedRelativePath
        );
        // 结构化预览不含路径，原样保留
        expect(hintCall.result_storage?.replacement_preview).toBe('输出预览');
        // 原文已复制到 fork 目录，按新命名空间可直接读到
        expect(fs.readFileSync(path.join(directory, forkedRelativePath), 'utf8')).toBe('original output');
    });
});

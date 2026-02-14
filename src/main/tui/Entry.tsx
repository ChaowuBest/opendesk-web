/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, useStdout, useInput } from 'ink';

import { GlobalState } from '../states/global.js';
import { TaskState, TaskUpdateChunk } from '../states/tasks.js';
import { ToolCallMessagePart, TextMessagePart } from '../agents/messages.js';
import { Banner } from '../tui/Banner';
import { AgentInput } from '../tui/AgentInput';
import { TaskView, type TaskViewItem, type TaskViewRef } from './TaskView.js';


export function AgentCLI() {
    const { stdout } = useStdout();
    const [terminalSize, setTerminalSize] = useState({ rows: stdout?.rows ?? 24, columns: stdout?.columns ?? 80 });

    useEffect(() => {
        if (!stdout) return;
        setTerminalSize({ rows: stdout.rows, columns: stdout.columns });
        const onResize = () => {
            setTerminalSize({ rows: stdout.rows, columns: stdout.columns });
        };
        stdout.on('resize', onResize);
        return () => { stdout.off('resize', onResize); };
    }, [stdout]);

    const [status, setStatus] = useState<'idle' | 'running'>('idle');
    const [tokenCount, setTokenCount] = useState<number | null>(null);
    const [items, setItems] = useState<TaskViewItem[]>([]);
    const [streamingAssistantText, setStreamingAssistantText] = useState<string | null>(null);
    const [promptMessage, setPromptMessage] = useState('❯');
    const currentTaskRef = useRef<TaskState | null>(null);
    const taskViewRef = useRef<TaskViewRef>(null);
    const rootBoxRef = useRef<React.ComponentRef<typeof Box> | null>(null);
    const state = GlobalState.getInstance();
    const initialPromptHandled = useRef(false);

    const createNewTask = useCallback(() => {
        currentTaskRef.current = state.taskManagerState.createTask();
        setItems([]);
        setStreamingAssistantText(null);
        setPromptMessage('❯ 新任务');
    }, [state.taskManagerState]);

    useInput((input, key) => {
        if (key.ctrl && (input === 'n' || input === '\x0e')) {
            createNewTask();
        } else if (key.escape) {
            taskViewRef.current?.scrollToEnd();
        }
    });

    const handleSubmit = useCallback(
        async (value: string) => {
            const prompt = value.trim();
            if (prompt === '') return;

            if (prompt === 'bye') {
                process.stdout.write('再见\n');
                process.exit(0);
            }

            if (currentTaskRef.current === null) {
                currentTaskRef.current = state.taskManagerState.createTask();
            }
            const task = currentTaskRef.current;

            setStatus('running');
            setTokenCount(null);
            setStreamingAssistantText(null);
            setItems((prev) => [...prev, { type: 'user', text: prompt }]);

            await task.submitUserMessage(prompt);
            await task.waitUntilFinished((chunkUpdate: TaskUpdateChunk) => {
                setTokenCount(chunkUpdate.usage?.total_tokens ?? null);
                if (chunkUpdate.last_part instanceof ToolCallMessagePart) {
                    for (const tc of chunkUpdate.last_part.toolcalls) {
                        if (tc.status === 'success' && tc.result != null) {
                            setItems((prev) => [
                                ...prev,
                                { type: 'tool', name: tc.tool_name, result: tc.result!, status: tc.status },
                            ]);
                        }
                    }
                }
                if (chunkUpdate.last_part instanceof TextMessagePart) {
                    const text = (chunkUpdate.last_part as TextMessagePart).text;
                    if (chunkUpdate.task_status === 'stopped') {
                        setItems((prev) => [...prev, { type: 'assistant', text }]);
                        setStreamingAssistantText(null);
                    } else {
                        setStreamingAssistantText(text);
                    }
                }
            });

            setPromptMessage('接下来有什么新的指示?');
            setStatus('idle');
        },
        [state.taskManagerState]
    );

    // 首次启动时若带有命令行参数 (argv[2])，自动作为第一条提示提交
    useEffect(() => {
        if (initialPromptHandled.current) return;
        const argPrompt = process.argv[2];
        if (argPrompt != null && argPrompt !== '' && status === 'idle') {
            initialPromptHandled.current = true;
            handleSubmit(argPrompt);
        }
    }, [status, handleSubmit]);

    const { columns, rows } = terminalSize;
    const taskViewWidth = Math.max(20, columns - 2);
    const displayItems: TaskViewItem[] =
        streamingAssistantText != null
            ? [...items, { type: 'assistant', text: streamingAssistantText }]
            : items;

    return (
        <Box
            ref={rootBoxRef}
            flexDirection="column"
            justifyContent='center'
            alignItems='center'
            width={columns}
            minHeight={rows}
            paddingX={2}
            paddingY={2}
        >
            <Box flexShrink={0}>
                <Banner />

            </Box>

            <Box flexDirection="column" minHeight={1}>
                <TaskView
                    ref={taskViewRef}
                    items={displayItems}
                    status={status}
                    tokenCount={tokenCount}
                    width={taskViewWidth}
                />
            </Box>

            <Box flexShrink={0}>
                <AgentInput
                    promptLabel={promptMessage}
                    onSubmit={handleSubmit}
                    currentTask={currentTaskRef.current}
                />
            </Box>
        </Box>
    );
}
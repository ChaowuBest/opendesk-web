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
import { ToolCallMessagePart, TextMessagePart, ReasoningMessagePart } from '../agents/messages.js';
import { Banner } from '../tui/Banner';
import { AgentInput } from '../tui/AgentInput';
import { TaskView, type MessageBlock, type UserMessageBlock, type AssistantMessageBlock, AssistantTextBlock, TaskStatus } from './TaskView.js';


function renderTaskUpdate(chunkUpdate: TaskUpdateChunk) {
}

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
    const [taskStatus, setTaskStatus] = useState<TaskStatus>({ finishedBlocks: [], completingBlocks: [] });
    const currentTaskRef = useRef<TaskState | null>(null);
    const state = GlobalState.getInstance();
    const initialPromptHandled = useRef(false);

    const createNewTask = useCallback(() => {
        currentTaskRef.current = state.taskManagerState.createTask();
        setTaskStatus({ finishedBlocks: [], completingBlocks: [] });
    }, [state.taskManagerState]);

    useInput((input, key) => {
        if (key.ctrl && (input === 'n' || input === '\x0e')) {
            createNewTask();
        }
    });

    const handleSubmit = async (value: string) => {
        const prompt = value.trim();
        if (prompt === '') return;
        else if (prompt === '/exit') {
            process.exit(0);
        }

        if (currentTaskRef.current === null) {
            /* 如果当前没有任务就创建一个 */
            currentTaskRef.current = state.taskManagerState.createTask();
        }
        const task = currentTaskRef.current;

        setStatus('running');
        setTokenCount(null);

        setTaskStatus((prev) => ({
            ...prev,
            finishedBlocks: [...prev.finishedBlocks, { role: 'user', text: prompt } as UserMessageBlock],
        }));

        await task.submitUserMessage(prompt);
        await task.waitUntilFinished((chunkUpdate: TaskUpdateChunk) => {
            // todo: this should be replaced by a more general task status
            const lastPart = chunkUpdate.last_part;
            let editedBlock: AssistantMessageBlock | undefined = undefined;

            if (lastPart instanceof TextMessagePart) {
                editedBlock = { role: 'assistant', type: 'text', text: lastPart.text };
            } else if (lastPart instanceof ReasoningMessagePart) {
                editedBlock = { role: 'assistant', type: 'reasoning', text: lastPart.content };
            } else if (lastPart instanceof ToolCallMessagePart) {
                editedBlock = { role: 'assistant', type: 'tool_call', toolcalls: lastPart.toolcalls };
            }

            if (!editedBlock) return;

            setTaskStatus((prev: TaskStatus) => {
                const completingBlocks = [...prev.completingBlocks];
                if (chunkUpdate.last_part_index >= completingBlocks.length) {
                    completingBlocks.push(editedBlock);
                } else {
                    completingBlocks[chunkUpdate.last_part_index] = editedBlock;
                }
                return { ...prev, completingBlocks: completingBlocks };
            })
        });

        setStatus('idle');
        setTaskStatus((prev) => ({
            ...prev,
            finishedBlocks: [...prev.finishedBlocks, ...prev.completingBlocks],
            completingBlocks: [],
        }));
    };

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

    return (
        <Box
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

            <Box flexDirection="column" minHeight={1} width='100%'>
                <TaskView taskStatus={taskStatus} />
            </Box>

            <Box flexShrink={0}>
                <AgentInput
                    promptLabel='@ HiShell'
                    onSubmit={handleSubmit}
                    currentTask={currentTaskRef.current}
                />
            </Box>
        </Box>
    );
}
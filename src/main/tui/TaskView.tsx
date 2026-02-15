/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for the full details.
 */

import { ToolCall } from '../agents/messages';
import React, { useMemo, memo } from 'react';
import { Box, Text } from 'ink';
import cliMarkdown from 'cli-markdown';
import { Usage } from '../agents/messages';


export interface UserMessageBlock {
    role: 'user';
    text: string;
    rendered?: string;
}

export interface AssistantTextBlock {
    role: 'assistant';
    type: 'text';
    text: string;
    rendered?: string;
}

export interface AssistantReasoningBlock {
    role: 'assistant';
    type: 'reasoning';
    text: string;
}

export interface AssistantToolCallBlock {
    role: 'assistant';
    type: 'tool_call';
    toolcalls: ToolCall[];
}

export type AssistantMessageBlock = AssistantTextBlock | AssistantReasoningBlock | AssistantToolCallBlock;

export type MessageBlock = UserMessageBlock | AssistantMessageBlock;

export interface TaskStatus {
    finishedBlocks: MessageBlock[];
    completingBlocks: MessageBlock[];
    usage?: Usage;
}

function UserMessage({ block }: { block: UserMessageBlock }) {
    return (
        <Box
            flexDirection="column"
            backgroundColor="#303030"
            paddingX={2}
            paddingY={1}
            marginBottom={1}
            minHeight={1}
            borderStyle="single"
            borderColor="gray"
            borderLeft={true}
            borderRight={false}
            borderTop={false}
            borderBottom={false}
        >
            <Text color="white">{block.text}</Text>
        </Box>
    );
}

function AssistantReasoningMessage({ block }: { block: AssistantReasoningBlock }) {
    return (
        <Box
            flexDirection="column"
            marginBottom={1}
            backgroundColor="yellowBright"
            paddingX={2}
            paddingY={1}
        >
            <Text color="black" italic>{block.text}</Text>
        </Box>
    );
}

function AssistantTextMessage({ block }: { block: AssistantTextBlock }) {
    if (block.rendered == null) {
        try {
            block.rendered = cliMarkdown(block.text);
        } catch (error) {
            block.rendered = block.text;
        }
    }
    return (
        <Box
            flexDirection="column"
            marginBottom={1}
        >
            <Text color="white">{block.rendered}</Text>
        </Box>
    );
}

function AssistantToolCallMessage({ block }: { block: AssistantToolCallBlock }) {
    return (
        <Box
            flexDirection="column"
            paddingX={1}
            marginBottom={1}
            minHeight={1}
        >
            <Text color="green" bold>
                ● {block.toolcalls.map((toolcall: ToolCall) => toolcall.tool_name).join(', ')}
            </Text>
        </Box>
    );
}

function ToolCallBlock({
    header,
    resultLines,
}: {
    header?: string;
    resultLines: string[];
}) {
    return (
        <Box flexDirection="column" paddingX={1} minHeight={1}>
            {header != null && (
                <Text color="green" bold>
                    ● {header}
                </Text>
            )}
        </Box>
    );
}

type TaskViewProps = {
    taskStatus: TaskStatus;
};

function renderBlock(block: MessageBlock, idx: number): React.ReactNode {
    switch (block.role) {
        case 'user':
            return <UserMessage key={`u-${idx}`} block={block} />;
        case 'assistant':
            switch (block.type) {
                case 'text':
                    return <AssistantTextMessage key={`a-${idx}`} block={block} />;
                case 'reasoning':
                    return <AssistantReasoningMessage key={`a-${idx}`} block={block} />;
                case 'tool_call':
                    return <AssistantToolCallMessage key={`a-${idx}`} block={block} />;
            }
    }
}

export function TaskView({ taskStatus }: TaskViewProps): React.ReactNode {
    const finishedItems = useMemo(() => taskStatus.finishedBlocks.map(renderBlock), [taskStatus.finishedBlocks]);
    const completingItems = useMemo(() => taskStatus.completingBlocks.map(renderBlock), [taskStatus.completingBlocks]);
    return (
        <Box flexDirection="column" width='100%'>
            <Box flexDirection="column">
                {finishedItems}
                {completingItems}
            </Box>
        </Box>
    );
};

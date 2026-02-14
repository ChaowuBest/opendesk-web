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

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import cliMarkdown from 'cli-markdown';

export type TaskViewItem =
    | { type: 'user'; text: string }
    | { type: 'tool'; name: string; result: string; status?: 'pending' | 'running' | 'success' | 'error' }
    | { type: 'assistant'; text: string };

export type TaskViewRef = {
    scrollUp: () => void;
    scrollDown: () => void;
    scrollToEnd: () => void;
};

type Block =
    | { type: 'user'; lineCount: number; text: string }
    | { type: 'tool'; lineCount: number; name: string; result: string; status?: string }
    | { type: 'assistant'; lineCount: number; text: string; renderedLines: string[] };

function itemsToBlocks(items: TaskViewItem[]): Block[] {
    const out: Block[] = [];
    for (const item of items) {
        if (item.type === 'user') {
            const lines = item.text.split(/\r?\n/);
            out.push({ type: 'user', lineCount: lines.length, text: item.text });
        } else if (item.type === 'tool') {
            const resultLines = (item.result ?? '').split(/\r?\n/);
            out.push({
                type: 'tool',
                lineCount: 1 + resultLines.length,
                name: item.name,
                result: item.result ?? '',
                status: item.status === 'error' ? 'err' : 'ok',
            });
        } else if (item.type === 'assistant') {
            const rendered = cliMarkdown(item.text);
            const renderedLines = rendered.split(/\r?\n/);
            out.push({
                type: 'assistant',
                lineCount: renderedLines.length,
                text: item.text,
                renderedLines,
            });
        }
    }
    return out;
}

function UserMessageBlock({ lines }: { lines: string[] }) {
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
            {lines.map((line, i) => (
                <Text key={i} color="white">{line}</Text>
            ))}
        </Box>
    );
}

function AssistantMessageBlock({ lines }: { lines: string[] }) {
    return (
        <Box
            flexDirection="column"
            marginBottom={1}
        >
            {lines.map((line, i) => (
                <Text key={i}>{line}</Text>
            ))}
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
    items: TaskViewItem[];
    status: 'idle' | 'running';
    tokenCount: number | null;
    width: number;
};

export const TaskView = function TaskView(
    { items, status, tokenCount, width }: TaskViewProps
) {
    const blocks = useMemo(() => itemsToBlocks(items), [items]);
    const hasRunning = status === 'running';
    const runningBlock: Block | null = hasRunning
        ? (() => {
            const text =
                tokenCount != null
                    ? `… 思考中 (${tokenCount} 词)`
                    : '… 思考中...';
            return {
                type: 'assistant' as const,
                lineCount: 1,
                text,
                renderedLines: [text],
            };
        })()
        : null;

    const allBlocks = runningBlock ? [...blocks, runningBlock] : blocks;
    return (
        <Box flexDirection="column" width={width}>
            <Box flexDirection="column" paddingX={1}>
                {allBlocks.map((block, idx) => {
                    if (block.type === 'user') {
                        const lines = block.text.split(/\r?\n/);
                        return <UserMessageBlock key={`u-${idx}`} lines={lines} />;
                    }
                    if (block.type === 'assistant') {
                        return (
                            <AssistantMessageBlock
                                key={`a-${idx}`}
                                lines={block.renderedLines}
                            />
                        );
                    }
                    const resultLines = block.result.split(/\r?\n/);
                    return (
                        <ToolCallBlock
                            key={`t-${idx}`}
                            header={`[${block.name}] ${block.status}`}
                            resultLines={resultLines}
                        />
                    );
                })}
            </Box>
        </Box>
    );
};

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

import React, { useState, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';
import { getLines, subscribe } from '../utils/cliLogStore.js';

const DISPLAY_LINES = 6;

/** 边框 + 内边距占用的列数，用于从终端总宽度推算日志内容可用宽度 */
const BORDER_AND_PADDING = 6;

/** 按可见长度截断，保留 ANSI 颜色码 */
function truncateVisible(str: string, maxVisible: number): string {
    let visible = 0;
    let i = 0;
    const suffix = '...';
    const max = maxVisible - suffix.length;
    while (i < str.length) {
        if (str[i] === '\x1b' && str[i + 1] === '[') {
            const end = str.indexOf('m', i + 2);
            i = end >= 0 ? end + 1 : str.length;
            continue;
        }
        visible++;
        if (visible > max) return str.slice(0, i) + suffix;
        i++;
    }
    return str;
}

function toSingleLine(raw: string, maxLineWidth: number): string {
    const firstLine = raw.split(/\r?\n/)[0] ?? '';
    return truncateVisible(firstLine, maxLineWidth);
}

type LogPanelProps = {
    /** 显示的行数 */
    maxLines?: number;
};

export function LogPanel({ maxLines = DISPLAY_LINES }: LogPanelProps) {
    const { stdout } = useStdout();
    const [columns, setColumns] = useState(stdout?.columns ?? 80);
    const [lines, setLines] = useState<string[]>(() => getLines());

    useEffect(() => {
        if (!stdout) return;
        const onResize = () => setColumns(stdout.columns);
        onResize();
        stdout.on('resize', onResize);
        return () => {
            stdout.off('resize', onResize);
        };
    }, [stdout]);

    useEffect(() => {
        const unsub = subscribe(() => setLines(getLines()));
        return () => {
            unsub();
        };
    }, []);

    const maxLineWidth = Math.max(20, columns - BORDER_AND_PADDING);
    const display = lines.slice(-maxLines).map((line) => toSingleLine(line, maxLineWidth));

    return (
        <Box
            width="100%"
            borderStyle="round"
            borderColor="green"
            flexDirection="column"
            paddingX={1}
            paddingY={0}
            marginTop={1}
        >
            <Box marginBottom={0}>
                <Text dimColor>
                    日志 (最近 {display.length} 条)
                </Text>
            </Box>
            <Box flexDirection="column" minHeight={maxLines}>
                {display.length === 0 ? (
                    <Text dimColor>
                        —
                    </Text>
                ) : (
                    display.map((line, i) => (
                        <Box key={i}>
                            <Text>{line}</Text>
                        </Box>
                    ))
                )}
            </Box>
        </Box>
    );
}

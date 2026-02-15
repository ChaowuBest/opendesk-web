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

import React, { useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { TaskState } from '../states/tasks';

type AgentInputProps = {
    promptLabel: string;
    onSubmit: (value: string) => void;
    currentTask: TaskState | null;
};

export function AgentInput({ promptLabel, onSubmit, currentTask }: AgentInputProps) {
    const [value, setValue] = useState('');

    const handleSubmit = useCallback(
        (v: string) => {
            onSubmit(v);
            setValue('');
        },
        [onSubmit]
    );

    return (
        <Box
            flexDirection="column"
            borderStyle="single"
            borderTop={true}
            borderBottom={true}
            borderLeft={false}
            borderRight={false}
            borderColor="gray"
            backgroundColor={'#303030'}
            marginTop={currentTask === null ? 0 : 1}
            padding={1}
            width={currentTask === null ? '60%' : '100%'}
        >
            <Box minHeight={currentTask === null ? '10' : '3'}>
                <Box marginRight={1}>
                    <Text color="cyan">〔{promptLabel}〕</Text>
                </Box>
                <TextInput
                    color="white"
                    value={value}
                    onChange={setValue}
                    onSubmit={handleSubmit}
                    placeholder="(/exit - 退出)"
                />
            </Box>
        </Box>
    );
}

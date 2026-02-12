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

type AgentInputProps = {
    promptLabel: string;
    onSubmit: (value: string) => void;
};

export function AgentInput({ promptLabel, onSubmit }: AgentInputProps) {
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
            width="100%"
        >
            <Box>
                <Box marginRight={1}>
                    <Text>{promptLabel} </Text>
                </Box>
                <TextInput
                    value={value}
                    onChange={setValue}
                    onSubmit={handleSubmit}
                    placeholder="(bye - 退出)"
                />
            </Box>
        </Box>
    );
}

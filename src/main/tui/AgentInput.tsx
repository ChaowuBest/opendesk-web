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

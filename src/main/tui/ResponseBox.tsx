import React from 'react';
import { Box, Text } from 'ink';


type ResponseBoxProps = {
    title: string;
    content: string;
};

export function ResponseBox({ title, content }: ResponseBoxProps) {
    const lines = content.split('\n');
    return (
        <Box borderStyle="round" borderColor="cyan" paddingX={1} paddingY={0} flexDirection="column" width="100%">
            <Text bold color="cyan">
                {title}
            </Text>
            {lines.map((line, i) => (
                <Text key={i}>{line}</Text>
            ))}
        </Box>
    );
}

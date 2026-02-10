import React from 'react';
import { Box, Text } from 'ink';

type ToolResultBoxProps = {
  toolName: string;
  result: string;
};

export function ToolResultBox({ toolName, result }: ToolResultBoxProps) {
  const lines = result.split('\n').filter(Boolean);
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} paddingY={0} marginBottom={1}>
      <Box flexDirection="column">
        <Text bold color="cyan">
          工具调用完成: {toolName}
        </Text>
      </Box>
    </Box>
  );
}

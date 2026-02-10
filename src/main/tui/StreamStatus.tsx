import React from 'react';
import { Text } from 'ink';

type StreamStatusProps = {
  tokenCount?: number;
};

export function StreamStatus({ tokenCount }: StreamStatusProps) {
  if (tokenCount == null) return null;
  return (
    <Text color="gray">
      正在组织回答 (已产生 {tokenCount} 词)
    </Text>
  );
}

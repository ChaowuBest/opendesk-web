import React from 'react';
import { Text } from 'ink';
import Spinner from 'ink-spinner';

type ThinkingSpinnerProps = {
  tokenCount: number | null;
};

export function ThinkingSpinner({ tokenCount }: ThinkingSpinnerProps) {
  const message =
    tokenCount != null
      ? `正在组织回答 (已产生 ${tokenCount} 词)`
      : '思考中...';

  return (
    <Text color="cyan">
      <Spinner type="dots" />
      {' '}
      {message}
    </Text>
  );
}

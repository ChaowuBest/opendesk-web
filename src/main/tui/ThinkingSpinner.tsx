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

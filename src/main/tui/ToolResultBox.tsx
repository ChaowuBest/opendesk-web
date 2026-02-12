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

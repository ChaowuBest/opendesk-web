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

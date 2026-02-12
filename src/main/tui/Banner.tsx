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

import React, { useRef, useLayoutEffect, useState } from 'react';
import { Box, Text, measureElement } from 'ink';
import { useStdoutDimensions } from 'ink-hooks';


const openDeskSmallLogo =`
░█▀█░█▀█░█▀▀░█▀█░█▀▄░█▀▀░█▀▀░█░█
░█░█░█▀▀░█▀▀░█░█░█░█░█▀▀░▀▀█░█▀▄
░▀▀▀░▀░░░▀▀▀░▀░▀░▀▀░░▀▀▀░▀▀▀░▀░▀
`;

const openDeskLargeLogo = `
 ██████╗ ██████╗ ███████╗███╗   ██╗██████╗ ███████╗███████╗██╗  ██╗
██╔═══██╗██╔══██╗██╔════╝████╗  ██║██╔══██╗██╔════╝██╔════╝██║ ██╔╝
██║   ██║██████╔╝█████╗  ██╔██╗ ██║██║  ██║█████╗  ███████╗█████╔╝
██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║██║  ██║██╔══╝  ╚════██║██╔═██╗
╚██████╔╝██║     ███████╗██║ ╚████║██████╔╝███████╗███████║██║  ██╗
 ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═╝
 `;


export function Banner() {
    const cwd = process.cwd();
    const pkg = { name: 'OpenDesk', version: '0.1.4' };

    const ref = useRef(null);
    const { columns } = useStdoutDimensions();
    const [ width, setWidth ] = useState(0);
    useLayoutEffect(() => {
        if (!ref.current) return;
        const { width: w } = measureElement(ref.current);
        setWidth(w);
    }, [columns]);

    let logoWidth: number;
    let logo: string;
    if (width >= 160) {
        logoWidth = 72;
        logo = openDeskLargeLogo;
    } else {
        logoWidth = 34;
        logo = openDeskSmallLogo;
    }

    return (
        <Box
            ref={ref}
            marginBottom={1}
            paddingX={4}
            paddingY={1}
            flexDirection="row"
            width="100%"
            minWidth={80}
            borderStyle="double"
        >
            <Box flexDirection="column" flexGrow={0} flexShrink={0} width={logoWidth}>
                <Box>
                    <Text>{logo}</Text>
                </Box>
                <Box flexDirection="column">
                    <Text bold dimColor>OpenDesk CLI v{pkg.version}</Text>
                </Box>
            </Box>

            {/* 竖线分隔 */}
            <Box borderLeft={true} borderStyle="single" width={1} marginX={1} minHeight={8} />

            {/* 右栏：入门提示、最近活动 */}
            <Box flexDirection="column" flexGrow={1} minWidth={24}>
                <Box marginBottom={1}>
                    <Text>Tips for getting started</Text>
                    <Text> </Text>
                </Box>
                <Box marginBottom={1}>
                    <Text dimColor>Run /init to create a CLAUDE.md file with instructions for Claude</Text>
                </Box>
                <Box borderBottom={true} borderStyle="single" marginBottom={1} />
                <Box>
                    <Text>Recent activity</Text>
                    <Text> </Text>
                </Box>
                <Box>
                    <Text dimColor>No recent activity</Text>
                </Box>
            </Box>
        </Box>
    );
}

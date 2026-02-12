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


const LOGO = `
░█▀█░█▀█░█▀▀░█▀█░█▀▄░█▀▀░█▀▀░█░█
░█░█░█▀▀░█▀▀░█░█░█░█░█▀▀░▀▀█░█▀▄
░▀▀▀░▀░░░▀▀▀░▀░▀░▀▀░░▀▀▀░▀▀▀░▀░▀
`;

export function Banner() {
    const pkg = { name: 'OpenDesk', version: '0.1.4' };

    const ref = useRef(null);
    const { columns } = useStdoutDimensions();
    const [ width, setWidth ] = useState(0);
    useLayoutEffect(() => {
        if (!ref.current) return;
        const { width: w } = measureElement(ref.current);
        setWidth(w);
    }, [columns]);

    return (
        <Box
            ref={ref}
            marginBottom={1}
            paddingX={2}
            flexDirection="row"
            width="100%"
            justifyContent="center"
        >
            <Box flexDirection="column" alignItems="center">
                <Text>{LOGO.substring(1)}</Text>
                <Text bold>Version {pkg.version}</Text>
            </Box>
        </Box>
    );
}

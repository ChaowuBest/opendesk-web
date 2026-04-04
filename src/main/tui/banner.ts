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

import { Box, Component, Text } from '@mariozechner/pi-tui';
import { HorizontalLayout } from './components/layout';
import { CenteredText } from './components/texts';
import chalk from 'chalk';

class Creators {
    static BG_LIGHT = '#404040';
    static BG_FONT = '#fefefe';
    static BG_ACCENT = '#F96850';
    static BG_SHADOW = '#303030';

    static O() {
        let line0 = '▄▄▄▄▄';
        let line1 = ' █▀█ ';
        let line2 = ' █░█ ';
        let line3 = ' ▀▀▀ ';
        let bottom = '▔▔▔▔▔';
        line0 = chalk.hex(this.BG_ACCENT)(line0);
        line1 = chalk.bgHex(this.BG_ACCENT).hex(this.BG_FONT)(line1);
        line2 = chalk.bgHex(this.BG_ACCENT).hex(this.BG_FONT)(line2);
        line3 = chalk.bgHex(this.BG_ACCENT).hex(this.BG_FONT)(line3);
        bottom = chalk.hex(this.BG_ACCENT)(bottom);
        return [line0, line1, line2, line3, bottom].join('\n');
    }

    static PEN() {
        let line0 = '▄▄▄▄▄▄▄▄▄▄▄▄▄';
        let line1 = ' █▀█ █▀▀ █▀█ ';
        let line2 = ' █▀▀ █▀▀ █ █ ';
        let line3 = ' ▀   ▀▀▀ ▀ ▀ ';
        let bottom = '▔▔▔▔▔▔▔▔▔▔▔▔▔';

        line0 = chalk.hex(this.BG_LIGHT)(line0);
        line1 = chalk.bgHex(this.BG_LIGHT).hex(this.BG_FONT)(line1);
        line2 = chalk.bgHex(this.BG_LIGHT).hex(this.BG_FONT)(line2);
        line3 = chalk.bgHex(this.BG_LIGHT).hex(this.BG_FONT)(line3);
        bottom = chalk.hex(this.BG_ACCENT)(bottom);
        return [line0, line1, line2, line3, bottom].join('\n');
    }

    static D() {
        let line0 = '▄▄▄▄▄';
        let line1 = ' █▀▄ ';
        let line2 = ' █░█ ';
        let line3 = ' ▀▀  ';
        let bottom = '▔▔▔▔▔';
        line0 = chalk.hex(this.BG_ACCENT)(line0);
        line1 = chalk.bgHex(this.BG_ACCENT).hex(this.BG_FONT)(line1);
        line2 = chalk.bgHex(this.BG_ACCENT).hex(this.BG_FONT)(line2);
        line3 = chalk.bgHex(this.BG_ACCENT).hex(this.BG_FONT)(line3);
        bottom = chalk.hex(this.BG_ACCENT)(bottom);
        return [line0, line1, line2, line3, bottom].join('\n');
    }

    static ESK() {
        let line0 = '▄▄▄▄▄▄▄▄▄▄▄▄▄';
        let line1 = ' █▀▀ █▀▀ █ █ ';
        let line2 = ' █▀▀ ▀▀█ █▀▄ ';
        let line3 = ' ▀▀▀ ▀▀▀ ▀ ▀ ';
        let bottom = '▔▔▔▔▔▔▔▔▔▔▔▔▔';
        line0 = chalk.hex(this.BG_LIGHT)(line0);
        line1 = chalk.bgHex(this.BG_LIGHT).hex(this.BG_FONT)(line1);
        line2 = chalk.bgHex(this.BG_LIGHT).hex(this.BG_FONT)(line2);
        line3 = chalk.bgHex(this.BG_LIGHT).hex(this.BG_FONT)(line3);
        bottom = chalk.hex(this.BG_ACCENT)(bottom);
        return [line0, line1, line2, line3, bottom].join('\n');
    }
}

function horizentalMerge(...pieces: string[]): string {
    const lines = pieces.map((piece) => piece.split('\n'));
    let result = '';
    for (let i = 0; i < lines[0].length; i++) {
        for (let j = 0; j < lines.length; j++) {
            result += lines[j][i];
        }
        result += '\n';
    }
    return result;
}

export class OpenDeskBanner implements Component {
    private workspace: string;
    private layout: Box = new Box(0, 0);

    private logo: HorizontalLayout = new HorizontalLayout({
        spacing: 1,
        padding: { left: 1, right: 1 }
    });

    constructor(workspace: string) {
        this.logo.addChild(
            new CenteredText(horizentalMerge(Creators.O(), Creators.PEN(), Creators.D(), Creators.ESK()))
        );
        this.workspace = workspace;
        this.layout.addChild(this.logo);
        this.layout.addChild(new CenteredText(chalk.dim('当前工作空间为: ') + this.workspace));
    }

    invalidate() {
        this.layout.invalidate();
    }

    render(width: number): string[] {
        return this.layout.render(width);
    }
}

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

import { BaseToolset } from "../../agents/tool";
import { BaseApplication } from "../base";
import { ExecuteCmdTool, ExecuteBashTool, WriteFileTool, ReadFileTool, ExecuteZshTool } from "./tools.js";


export class TerminalApplication extends BaseApplication {
    constructor() {
        super('terminal', '终端', false);
    }

    async getToolsets(): Promise<BaseToolset[]> {
        const toolset = new BaseToolset('terminal');

        switch (process.platform as string) {
            case 'win32':
                toolset.addTool(new ExecuteCmdTool());
                break;
            case 'openharmony':
                toolset.addTool(new ExecuteZshTool());
                break;
            default:
                toolset.addTool(new ExecuteBashTool());
                break;
        }

        toolset.addTool(new ReadFileTool());
        toolset.addTool(new WriteFileTool());
        return [toolset];
    }
}
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

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { assertOpenGenOfficeHapPayload, stageOpenGenOfficeHapPayload } = require('@bitclub.ai/open-genoffice/hap');

function stageOpenGenOfficeForOhos(appDir) {
    const resolvedAppDir = path.resolve(appDir);
    if (!fs.statSync(resolvedAppDir).isDirectory()) {
        throw new Error(`OHOS app 目录不存在: ${resolvedAppDir}`);
    }

    const compatPath = path.join(resolvedAppDir, 'dist', 'main', 'ohos-compat.js');
    if (!fs.existsSync(compatPath)) {
        throw new Error('请先通过 OpenDesk-ohos 的 sync-minimal-only 或 sync-dist-only 流程同步基线产物');
    }

    stageOpenGenOfficeHapPayload(resolvedAppDir);
    assertOpenGenOfficeHapPayload(resolvedAppDir);
}

function main() {
    const [appDir, ...unexpectedArgs] = process.argv.slice(2);
    if (!appDir || unexpectedArgs.length > 0) {
        throw new Error('用法: node scripts/stage-open-genoffice-ohos.cjs <ohos-app-dir>');
    }

    stageOpenGenOfficeForOhos(appDir);
    console.log('[ohos-slides] 已叠加并校验 Open Slides 发布产物');
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`[ohos-slides] ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    stageOpenGenOfficeForOhos
};

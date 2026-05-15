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

import Alpine from 'alpinejs';

import '../components/agentinput.js';
import '../components/notification.js';
import '../components/permissionPrompt.ts';
import '../components/askUserPrompt.ts';
import '../components/exitPlanModePrompt.ts';
import '../components/splitter.js';
import '../components/toolbar.ts';
import '../components/taskview.js';
import '../components/sidebar.js';
import '../components/setting.js';
import '../components/settingpanel.js';
import '../components/logview.js';
import '../components/fileview.js';
import '../components/recommendation.ts';
import '../components/homepage.js';
import '../components/wizard.ts';
import '../components/schemaeditor.js';
import '../../main/applications/ppt/renderer/pptcontainer.js';
import '../components/shortcutManager.ts';
import '../components/shortcutHelp.ts';
import './magicPointer.js';
import '../../main/applications/webbrowser/renderer/entry.ts';

window.Alpine = Alpine;
Alpine.start();

requestAnimationFrame(() => {
    const appRoot = document.getElementById('app-root');
    if (appRoot) appRoot.style.opacity = '1';
});

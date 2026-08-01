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

import '../theme/theme.css';
import '../styles/common.css';
import '../styles/custom.css';
import '../styles/context-menu.css';

import '../components/loading.js';
import '../components/agentinput.js';
import '../components/permissionPrompt.ts';
import '../components/askUserPrompt.ts';
import '../components/exitPlanModePrompt.ts';
import '../components/taskview.js';
import '../components/splitter.js';

import './application-host.ts';

window.Alpine = Alpine;
Alpine.start();

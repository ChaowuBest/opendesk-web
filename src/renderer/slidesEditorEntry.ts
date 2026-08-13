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

import { bootstrapOpenDeskOfficeSlidesEditor, type ExtensionActionContext } from '@bitclub.ai/opendesk-office/renderer';

interface SlidesHostBridge {
    notifyExtensionAction(payload: unknown): void;
}

const params = new URLSearchParams(window.location.search);
const extensionGroupLabel = params.get('extensionGroupLabel');
const selectionActionLabel = params.get('selectionActionLabel');
const selectionActionTitle = params.get('selectionActionTitle');

void bootstrapOpenDeskOfficeSlidesEditor({
    editor: {
        ...(extensionGroupLabel ? { extensionGroupLabel } : {}),
        extensionActions:
            selectionActionLabel && selectionActionTitle
                ? [
                      {
                          id: 'opendesk-ai-selection',
                          label: selectionActionLabel,
                          title: selectionActionTitle,
                          icon: 'sparkles',
                          placements: ['canvas-toolbar'],
                          requiresSelection: true
                      }
                  ]
                : [],
        onExtensionAction(action, placement, context: ExtensionActionContext) {
            const bridge = (window as unknown as { openDeskOfficeHostBridge?: SlidesHostBridge })
                .openDeskOfficeHostBridge;
            bridge?.notifyExtensionAction({ action, placement, context });
        }
    }
});

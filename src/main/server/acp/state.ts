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

import fs from 'fs';
import path from 'path';
import { getOpendeskDirectory } from '../../utils/setting.js';
import { logger } from '../../utils/logger.js';

interface AcpStateData {
    default_model?: string;
}

const ACP_STATE_FILE = path.join('servers', 'acp', 'state.json');

/**
 * Manages ACP-specific persistent state stored in servers/acp/state.json.
 *
 * ACP maintains its own default model selection so that reconnecting clients
 * don't need to re-select the model every time. The state is stored separately
 * from OpenDesk's global setting.json to avoid cross-contamination.
 *
 * Model resolution priority:
 * 1. ACP's stored default model (if still valid in OpenDesk's config)
 * 2. OpenDesk's global default model (if valid)
 * 3. First available chat model
 */
export class AcpState {
    private static instance: AcpState | null = null;
    private data: AcpStateData;
    private readonly filePath: string;

    constructor(filePath: string) {
        this.filePath = filePath;
        this.data = this.load();
    }

    static getInstance(): AcpState {
        if (AcpState.instance === null) {
            const filePath = path.join(getOpendeskDirectory(), ACP_STATE_FILE);
            AcpState.instance = new AcpState(filePath);
        }
        return AcpState.instance;
    }

    /**
     * Reset the singleton instance. Used for testing only.
     */
    static resetInstance(): void {
        AcpState.instance = null;
    }

    private load(): AcpStateData {
        try {
            if (fs.existsSync(this.filePath)) {
                const content = fs.readFileSync(this.filePath, 'utf8');
                if (content && content.trim()) {
                    const parsed = JSON.parse(content);
                    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                        return parsed as AcpStateData;
                    }
                }
            }
        } catch (err) {
            logger.warn(`Failed to load ACP state from ${this.filePath}: ${err}`);
        }
        return {};
    }

    private save(): void {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 4), 'utf8');
        } catch (err) {
            logger.warn(`Failed to save ACP state to ${this.filePath}: ${err}`);
        }
    }

    getDefaultModel(): string | undefined {
        return this.data.default_model || undefined;
    }

    setDefaultModel(model: string): void {
        this.data.default_model = model;
        this.save();
    }

    clearDefaultModel(): void {
        delete this.data.default_model;
        this.save();
    }

    /**
     * Resolve the effective default model for new ACP sessions.
     *
     * @param opendeskDefaultModel - OpenDesk's global default model alias (from setting.json)
     * @param validChatModels - List of currently valid chat model aliases
     * @returns The resolved model alias, or undefined if no models are available
     *
     * Resolution priority:
     * 1. ACP's stored default model (if still in validChatModels)
     * 2. OpenDesk's global default model (if in validChatModels)
     * 3. First entry in validChatModels
     *
     * Side effect: if the stored model is no longer valid, it is cleared.
     */
    resolveDefaultModel(opendeskDefaultModel: string | undefined, validChatModels: string[]): string | undefined {
        if (validChatModels.length === 0) {
            return undefined;
        }

        const acpModel = this.getDefaultModel();

        // ACP has a stored model and it's still valid
        if (acpModel && validChatModels.includes(acpModel)) {
            return acpModel;
        }

        // ACP's stored model is stale — clear it
        if (acpModel) {
            logger.info(`ACP stored model "${acpModel}" no longer exists, falling back to OpenDesk default`);
            this.clearDefaultModel();
        }

        // Fall back to OpenDesk's global default
        if (opendeskDefaultModel && validChatModels.includes(opendeskDefaultModel)) {
            return opendeskDefaultModel;
        }

        // Last resort: first available chat model
        return validChatModels[0];
    }
}

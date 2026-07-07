import { type Component, type TUI } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { t } from '../../../../locale/index.js';
import {
    DEFAULT_GATEWAY_HOST,
    DISABLED_GATEWAY_HOST,
    listGatewayListenHostOptions,
    normalizeGatewayHost,
    parseDeviceMgrConfig,
    type DeviceMgrConfig
} from '../../../applications/devicemgr/common.js';
import { Setting } from '../../../utils/setting.js';
import { ConfigForm, type ActionDef, type FieldDef } from './form.js';

function getGatewayConfig(): DeviceMgrConfig {
    try {
        return parseDeviceMgrConfig(Setting.getInstance().getApplicationConfig('devicemgr'));
    } catch {
        return parseDeviceMgrConfig({});
    }
}

function saveGatewayConfig(config: DeviceMgrConfig): void {
    const setting = Setting.getInstance();
    const data = setting.getData() as any;
    setting.setData({
        ...data,
        applications: {
            ...(data.applications ?? {}),
            devicemgr: config
        }
    });
}

/**
 * TUI 设备网关设置页面。
 */
export class GatewayConfigPage implements Component {
    private tui: TUI;
    private onBack: () => void;
    private onConfigChange?: () => void;
    private form?: ConfigForm;
    private errorMessage?: string;

    constructor(tui: TUI, onBack: () => void, onConfigChange?: () => void) {
        this.tui = tui;
        this.onBack = onBack;
        this.onConfigChange = onConfigChange;
        this.showForm();
    }

    private showForm(): void {
        const config = getGatewayConfig();
        const currentHost = config.enabled ? normalizeGatewayHost(config.host) : DISABLED_GATEWAY_HOST;
        const hostOptions = listGatewayListenHostOptions();
        if (!hostOptions.some((option) => option.value === currentHost)) {
            hostOptions.push({
                value: currentHost || DEFAULT_GATEWAY_HOST,
                label: currentHost || DEFAULT_GATEWAY_HOST
            });
        }
        const hostOptionLabels = Object.fromEntries(hostOptions.map((option) => [option.value, option.label]));
        const gatewayEnabled = currentHost !== DISABLED_GATEWAY_HOST;

        const fields: FieldDef[] = [
            {
                type: 'select',
                key: 'host',
                label: t('config.gateway.field.host'),
                value: currentHost,
                options: hostOptions.map((option) => option.value),
                optionLabels: hostOptionLabels
            },
            {
                type: 'text',
                key: 'port',
                label: t('config.gateway.field.port'),
                value: String(config.port),
                visible: gatewayEnabled
            },
            {
                type: 'boolean',
                key: 'autoApproveLocal',
                label: t('config.gateway.field.autoApproveLocal'),
                value: config.autoApproveLocal,
                visible: gatewayEnabled
            }
        ];

        const actions: ActionDef[] = [
            { key: 'save', label: t('config.common.save'), style: 'primary' },
            { key: 'cancel', label: t('config.common.cancel') }
        ];

        this.form = new ConfigForm(
            this.tui,
            t('config.gateway.title'),
            fields,
            actions,
            (actionKey, values) => {
                if (actionKey === 'save') this.save(values);
                else this.close();
            },
            () => this.close(),
            (values) => this.onAnyFieldChange(values)
        );
        this.form.activate();
        this.tui.requestRender();
    }

    private onAnyFieldChange(values: Record<string, any>): void {
        const gatewayEnabled = normalizeGatewayHost(values.host) !== DISABLED_GATEWAY_HOST;
        this.form?.setItemsVisible(['port', 'autoApproveLocal'], gatewayEnabled);
        this.tui.requestRender();
    }

    private close(): void {
        this.form?.deactivate();
        this.form = undefined;
        this.onBack();
    }

    private save(values: Record<string, any>): void {
        const host = normalizeGatewayHost(values.host);
        const gatewayEnabled = host !== DISABLED_GATEWAY_HOST;
        const port = parseInt(String(values.port ?? ''), 10);

        if (gatewayEnabled && (!Number.isInteger(port) || port < 1 || port > 65535)) {
            this.errorMessage = t('config.gateway.error.port');
            this.tui.requestRender();
            return;
        }

        saveGatewayConfig({
            enabled: gatewayEnabled,
            host,
            port: Number.isInteger(port) ? port : 19010,
            autoApproveLocal: values.autoApproveLocal !== false
        });
        this.onConfigChange?.();
        this.close();
    }

    invalidate() {}

    render(width: number): string[] {
        if (!this.form) return [];
        const lines = this.form.render(width);
        if (this.errorMessage) {
            lines.splice(Math.max(0, lines.length - 1), 0, '', chalk.red(`  ${this.errorMessage}`));
        }
        return lines;
    }
}

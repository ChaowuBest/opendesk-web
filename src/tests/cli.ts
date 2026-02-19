import fs from 'fs';
import path from 'path';

function getSettingPath(): string {
    const appData = process.env.APPDATA;
    if (!appData) {
        throw new Error('APPDATA environment variable not found');
    }
    return path.join(appData, 'opendesk', 'setting.json');
}

function loadRawSetting(): Record<string, any> {
    const settingPath = getSettingPath();
    if (!fs.existsSync(settingPath)) {
        throw new Error(`配置文件不存在: ${settingPath}`);
    }
    return JSON.parse(fs.readFileSync(settingPath, 'utf8'));
}

function cmdGetConfig(appName?: string) {
    const setting = loadRawSetting();

    if (appName) {
        const appConfig = setting.applications?.[appName];
        if (appConfig === undefined) {
            console.error(`未找到应用 "${appName}" 的配置`);
            process.exit(1);
        }
        console.log(JSON.stringify(appConfig, null, 2));
    } else {
        console.log(JSON.stringify(setting, null, 2));
    }
}

const commands: Record<string, (...args: string[]) => void> = {
    'get-config': cmdGetConfig,
};

function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    if (!command || command === '--help') {
        console.log('用法: npm run test-cli -- <command> [args...]');
        console.log('可用命令:');
        console.log('  get-config [app-name]  获取配置（可选指定应用名）');
        process.exit(0);
    }

    const handler = commands[command];
    if (!handler) {
        console.error(`未知命令: ${command}`);
        console.error('可用命令: ' + Object.keys(commands).join(', '));
        process.exit(1);
    }

    handler(...args.slice(1));
}

main();

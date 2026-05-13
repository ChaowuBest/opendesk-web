import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface DriveInfo {
    name: string;
    path: string;
    isDirectory: boolean;
    isDrive: boolean;
    driveLetter?: string;
    size?: number;
    free?: number;
}

/**
 * 获取 Windows 系统盘符列表
 * 支持 PowerShell 和 wmic 两种方式
 */
export async function getWindowsDrives(): Promise<DriveInfo[]> {
    if (process.platform !== 'win32') {
        return [];
    }

    try {
        // 方法1：使用 PowerShell 获取盘符信息（包含容量）
        const { stdout } = await execAsync(
            'powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | Select-Object Name, Root, Used, Free | ConvertTo-Json"',
            { timeout: 5000 }
        );

        const drives = JSON.parse(stdout);
        const driveList = Array.isArray(drives) ? drives : [drives];

        return driveList
            .filter((d: any) => d.Name && d.Root)
            .map((d: any) => ({
                name: `本地磁盘 (${d.Name}:)`,
                path: d.Root,
                isDirectory: true,
                isDrive: true,
                driveLetter: d.Name,
                size: d.Used ? d.Used + (d.Free || 0) : undefined,
                free: d.Free || undefined
            }));
    } catch (error) {
        // 方法2：回退到 wmic（兼容性更好）
        try {
            const { stdout } = await execAsync('wmic logicaldisk get name', { timeout: 3000 });
            const lines = stdout.trim().split('\n').slice(1);

            return lines
                .map((line) => line.trim())
                .filter((line) => line && /^[A-Z]:$/.test(line))
                .map((drive) => ({
                    name: `本地磁盘 (${drive})`,
                    path: drive.replace(':', ':\\'),
                    isDirectory: true,
                    isDrive: true,
                    driveLetter: drive.replace(':', '')
                }));
        } catch (fallbackError) {
            console.error('Failed to get Windows drives:', fallbackError);
            return [];
        }
    }
}

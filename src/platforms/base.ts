import open from 'open';


export abstract class AbstractPlatform {
    static async openPath(filePath: string) {
        await open(filePath);
    }

    static async showItemInFolder(filePath: string) {

    }

    static getWorkerPath(): string {
        // 返回当前正在执行的入口文件路径
        console.log(process.argv);
        return process.argv[1];
    }
}

let __platform: typeof AbstractPlatform | null = null;

export function setPlatform(platform: typeof AbstractPlatform) {
    __platform = platform;
}

export function getPlatform(): typeof AbstractPlatform {
    if (__platform === null) {
        throw new Error('Platform is not set');
    }
    return __platform;
}

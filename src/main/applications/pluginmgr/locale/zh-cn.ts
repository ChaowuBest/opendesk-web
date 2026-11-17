/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

export const zhCn: Record<string, string> = {
    'app.name': '插件',
    'app.event.pluginsChanged': '插件安装、卸载、启停或重载后触发',
    'app.event.appearanceChanged': '插件修改应用外观（如名称、Logo）后触发',
    'app.event.registriesChanged': '插件仓库（插件市场来源）发生变化后触发',
    'app.event.marketInstallProgress': '从插件市场下载并安装插件时触发，用于显示下载进度',

    // 插件市场清单解析
    'market.entryInvalid': '插件条目的格式不正确',
    'market.entryIdMissing': '插件条目缺少 id',
    'market.entryIdInvalid': '插件 id 不合法：${id}',
    'market.entryVersionInvalid': '插件版本号不是合法的 SemVer：${version}',
    'market.entryHostVersionInvalid': '插件声明的 ${field} 不是合法的 SemVer：${version}',
    'market.entryApiVersionUnsupported': '插件声明的 apiVersion 不受支持：${apiVersion}',
    'market.entryPlatformsInvalid':
        '插件声明的 platforms 不合法（只接受 win32 / darwin / linux / android / openharmony）',
    'market.entryAuthorInvalid': '插件作者信息不合法：需要 name，homepage 只接受 http(s) 地址',
    'market.platformUnsupported': '插件 ${id} 不支持当前平台（仅支持 ${platforms}）',
    'market.hostVersionUnsupported': '插件 ${id} 需要 OpenDesk ${range}，当前版本 ${current}',
    'market.entryDownloadUrlMissing': '插件条目缺少下载地址',
    'market.entryDownloadUrlInvalid': '插件下载地址不合法：${url}',
    'market.entryDownloadUrlInsecure': '插件下载地址必须使用 https：${url}',
    'market.entryDownloadUrlNotArchive': '插件下载地址必须是 .zip、.tgz 或 .tar.gz 归档包：${url}',
    'market.entryRejected': '第 ${index} 条插件不可用：${detail}',
    'market.fetchFailed': '无法拉取插件清单 ${url}：${message}',
    'market.catalogFileReadFailed': '无法读取插件清单 ${path}：${message}',
    'market.registryNotFound': '未找到插件市场：${name}',
    'market.entryNotFound': '插件市场里没有插件 ${id}',
    'market.entryIdMismatch': '市场条目声明的 id（${expected}）与插件包内的 id（${actual}）不一致，已按包内 id 安装',
    'market.entryManifestMismatch': '插件 ${id} 的包内清单与市场条目不一致，安装已中止：${fields}',
    'market.fieldDiff': '${field}（市场 ${market} / 插件 ${plugin}）',
    'market.fieldSeparator': '、',
    'error.installFailed': '安装失败：${reason}',
    'error.installFailedDetail': '安装失败：${reason}（${detail}）',

    // 插件仓库
    'error.channelNameMissing': '请填写仓库名称',
    'error.channelNameTooLong': '仓库名称不能超过 80 个字符',
    'error.channelUrlMissing': '请填写插件清单地址',
    'error.channelUrlInvalid': '插件清单地址不合法：${url}',
    'error.channelUrlExists': '该地址已被其它仓库使用：${url}',
    'error.channelNameExists': '仓库名称已被使用：${name}',
    'error.channelLimit': '自定义插件仓库最多只能添加 ${count} 个',
    'error.channelNotFound': '未找到该插件仓库',
    'error.channelDefaultReadonly': '官方插件市场不能改名、改地址或删除，只能启用或禁用',
    'error.channelVerifyFailed': '插件清单验证失败 ${url}：${message}',
    'error.channelEmpty': '该地址下没有任何插件：${url}'
};

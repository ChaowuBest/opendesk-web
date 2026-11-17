/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

export const enUs: Record<string, string> = {
    'app.name': 'Plugins',
    'app.event.pluginsChanged': 'Triggered after plugins are installed, uninstalled, enabled, disabled, or reloaded',
    'app.event.appearanceChanged': 'Triggered after a plugin changes the application appearance (e.g. name, logo)',
    'app.event.registriesChanged': 'Triggered after plugin registries (plugin marketplace sources) change',
    'app.event.marketInstallProgress': 'Triggered while downloading and installing a plugin from the marketplace',

    // Plugin catalog parsing
    'market.entryInvalid': 'Invalid plugin entry',
    'market.entryIdMissing': 'Plugin entry is missing the id field',
    'market.entryIdInvalid': 'Invalid plugin id: ${id}',
    'market.entryVersionInvalid': 'Plugin version is not a valid SemVer: ${version}',
    'market.entryHostVersionInvalid': '${field} declared by the marketplace entry is not a valid SemVer: ${version}',
    'market.entryApiVersionUnsupported': 'Unsupported plugin apiVersion: ${apiVersion}',
    'market.entryPlatformsInvalid':
        'Invalid plugin platforms (only win32 / darwin / linux / android / openharmony are accepted)',
    'market.entryAuthorInvalid': 'Invalid author: name is required and homepage must be an http(s) URL',
    'market.platformUnsupported': 'Plugin ${id} does not support the current platform (only ${platforms})',
    'market.hostVersionUnsupported': 'Plugin ${id} requires OpenDesk ${range}; the current version is ${current}',
    'market.entryDownloadUrlMissing': 'Plugin entry is missing the download URL',
    'market.entryDownloadUrlInvalid': 'Invalid plugin download URL: ${url}',
    'market.entryDownloadUrlInsecure': 'Plugin download URL must use https: ${url}',
    'market.entryDownloadUrlNotArchive': 'Plugin download URL must point to a .zip, .tgz or .tar.gz archive: ${url}',
    'market.entryRejected': 'Plugin entry #${index} is unusable: ${detail}',
    'market.fetchFailed': 'Failed to fetch plugin catalog ${url}: ${message}',
    'market.catalogFileReadFailed': 'Failed to read plugin catalog ${path}: ${message}',
    'market.registryNotFound': 'Plugin marketplace not found: ${name}',
    'market.entryNotFound': 'Plugin ${id} is not in this marketplace',
    'market.entryIdMismatch':
        'The id declared by the marketplace entry (${expected}) does not match the id inside the plugin package (${actual}); the package id was used',
    'market.entryManifestMismatch':
        'The package manifest of plugin ${id} does not match the marketplace entry; the installation was aborted: ${fields}',
    'market.fieldDiff': '${field} (marketplace ${market} / plugin ${plugin})',
    'market.fieldSeparator': ', ',
    'error.installFailed': 'Installation failed: ${reason}',
    'error.installFailedDetail': 'Installation failed: ${reason} (${detail})',

    // Plugin channels
    'error.channelNameMissing': 'Please enter a registry name',
    'error.channelNameTooLong': 'Registry name must not exceed 80 characters',
    'error.channelUrlMissing': 'Please enter the plugin catalog URL',
    'error.channelUrlInvalid': 'Invalid plugin catalog URL: ${url}',
    'error.channelUrlExists': 'Another registry already uses this URL: ${url}',
    'error.channelNameExists': 'Registry name is already in use: ${name}',
    'error.channelLimit': 'At most ${count} custom plugin registries are allowed',
    'error.channelNotFound': 'Plugin registry not found',
    'error.channelDefaultReadonly':
        'The official marketplace cannot be renamed, re-pointed or deleted; it can only be enabled or disabled',
    'error.channelVerifyFailed': 'Plugin catalog verification failed for ${url}: ${message}',
    'error.channelEmpty': 'No plugin found at ${url}'
};

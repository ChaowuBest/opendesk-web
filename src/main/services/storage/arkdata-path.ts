import * as crypto from 'crypto';

export function toArkDataDbPath(dbPath: string): string {
    if (dbPath.endsWith('-arkdata-database.db')) return dbPath;
    return dbPath.endsWith('.db') ? dbPath.replace(/\.db$/, '-arkdata-database.db') : `${dbPath}-arkdata-database.db`;
}

export function createArkDataStoreId(prefix: string, dbPath: string): string {
    const hash = crypto.createHash('sha1').update(dbPath).digest('hex').slice(0, 16);
    return `${prefix}:${hash}`;
}

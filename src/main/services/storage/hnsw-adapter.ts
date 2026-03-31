import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

type HnswModule = {
    HNSW: new (M: number, efConstruction: number, d: number, metric?: 'cosine' | 'euclidean', efSearch?: number) => any;
    HNSWWithDB?: unknown;
};

export interface HnswPoint {
    id: string;
    vector: number[];
}

export interface HnswSearchResult {
    id: string;
    score: number;
}

type HnswSearchOptions = {
    efSearch?: number;
};

function loadHnswCtor(): HnswModule['HNSW'] {
    const mod = require('hnsw') as HnswModule;
    if (!mod?.HNSW) {
        throw new Error('hnsw package does not export HNSW');
    }
    return mod.HNSW;
}

function ensureVectorDim(vector: number[], dim: number): void {
    if (!Array.isArray(vector)) {
        throw new Error('vector must be an array');
    }
    if (vector.length !== dim) {
        throw new Error(`Vector dimension mismatch: expected ${dim}, got ${vector.length}`);
    }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
    fs.renameSync(tmpPath, filePath);
}

/**
 * HnswAdapter wraps the in-memory HNSW lifecycle and JSON snapshot persistence.
 */
export class HnswAdapter {
    private static HNSW: HnswModule['HNSW'] | null = null;
    private hnsw: any;
    private readonly dim: number;
    private readonly snapshotPath: string;
    private readonly M: number;
    private readonly efConstruction: number;
    private readonly metric: 'cosine' | 'euclidean';
    private readonly efSearch?: number;

    constructor(
        dim: number,
        snapshotPath: string,
        options?: {
            M?: number;
            efConstruction?: number;
            metric?: 'cosine' | 'euclidean';
            efSearch?: number;
        }
    ) {
        this.dim = dim;
        this.snapshotPath = snapshotPath;
        this.M = options?.M ?? 16;
        this.efConstruction = options?.efConstruction ?? 200;
        this.metric = options?.metric ?? 'cosine';
        this.efSearch = options?.efSearch;

        if (!HnswAdapter.HNSW) {
            HnswAdapter.HNSW = loadHnswCtor();
        }

        this.hnsw = new HnswAdapter.HNSW(this.M, this.efConstruction, this.dim, this.metric, this.efSearch);
    }

    private createFreshIndex(): any {
        if (!HnswAdapter.HNSW) {
            HnswAdapter.HNSW = loadHnswCtor();
        }
        return new HnswAdapter.HNSW(this.M, this.efConstruction, this.dim, this.metric, this.efSearch);
    }

    searchKNN(queryVector: number[], k: number, options?: HnswSearchOptions): HnswSearchResult[] {
        ensureVectorDim(queryVector, this.dim);
        return this.hnsw.searchKNN(queryVector, k, options);
    }

    async addPoint(id: string, vector: number[]): Promise<void> {
        ensureVectorDim(vector, this.dim);
        await this.hnsw.addPoint(id, vector);
    }

    async buildIndex(points: HnswPoint[]): Promise<void> {
        const dataset = points.map((point) => {
            ensureVectorDim(point.vector, this.dim);
            return { id: point.id, vector: point.vector };
        });
        await this.hnsw.buildIndex(dataset);
    }

    async saveSnapshot(): Promise<void> {
        writeJsonAtomic(this.snapshotPath, this.hnsw.toJSON());
    }

    async loadSnapshot(): Promise<void> {
        if (!fs.existsSync(this.snapshotPath)) return;
        const json = JSON.parse(fs.readFileSync(this.snapshotPath, 'utf8'));
        this.hnsw = HnswAdapter.HNSW!.fromJSON(json);
    }

    async rebuild(points: HnswPoint[]): Promise<void> {
        const newHnsw = this.createFreshIndex();
        const dataset = points.map((point) => {
            ensureVectorDim(point.vector, this.dim);
            return { id: point.id, vector: point.vector };
        });

        if (dataset.length > 0) {
            await newHnsw.buildIndex(dataset);
        }

        const snapshot = newHnsw.toJSON();
        writeJsonAtomic(this.snapshotPath, snapshot);
        this.hnsw = newHnsw;
    }
}


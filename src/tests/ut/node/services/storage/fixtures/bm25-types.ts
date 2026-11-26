import type {
    BaseStorage,
    BM25RecordHit,
    BM25SearchOptions,
    BM25StoreProbeResult,
    Item,
    SearchItem,
    IndexerSearchOptions as PublicSearchOptions
} from '../../../../../../main/services/storage/abstract-storage.js';
import type { IndexerSearchOptions, IndexerSearchCandidate } from '../../../../../../main/services/storage/indexer.js';

export async function verifyPublicTypes(storage: BaseStorage, items: Item[], complete: SearchItem[]) {
    const options: BM25SearchOptions = { field: 'text', topK: 10, allowedItemIds: ['a'] as const };
    const hits: BM25RecordHit[] = await storage.searchBM25('query', options);
    const candidate: IndexerSearchCandidate = { item_id: 'candidate' };
    const internal: IndexerSearchOptions = { existingResults: [candidate, ...items] };
    const external: PublicSearchOptions = { existingResults: complete };
    // @ts-expect-error A public result must retain a complete real Item.
    const invalid: SearchItem = { item: { item_id: 'candidate' } };
    // @ts-expect-error Public existingResults retains SearchItem[], not internal candidates.
    const invalidPublic: PublicSearchOptions = { existingResults: [candidate] };
    const scope = await storage.searchScope({
        preconditions: [{ indexer: 'BaseIndexer', field: 'item_type', operator: '=', value: 'memory' }],
        targetCondition: { indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: { query: 'query' } }
    });
    const subKey: string | undefined = scope.items[0]?.bm25Record?.subKey;
    const probes = await storage.probeIndexers(['BM25Indexer', 'VectorIndexer']);
    const result: BM25StoreProbeResult | undefined = probes.BM25Indexer;
    if (result?.status === 'exists') {
        const version: number = result.indexVersion;
        void version;
    }
    const legacy: 'exists' | 'missing' | 'open_failed' | undefined = probes.VectorIndexer;
    return { hits, internal, external, invalid, invalidPublic, subKey, legacy };
}

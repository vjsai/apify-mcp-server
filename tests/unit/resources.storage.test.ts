import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import type { ApifyClient } from '../../src/apify_client.js';
import { KV_RECORD_MAX_INLINE_BYTES } from '../../src/const.js';
import {
    isStorageUri,
    listStorageResources,
    readStorageResource,
    STORAGE_RESOURCE_TEMPLATES,
} from '../../src/resources/storage_resources.js';

// `contents[0]` is a text|blob union; narrow it in tests that read one shape.
function firstContent(result: ReadResourceResult): { mimeType?: string; text?: string; blob?: string } {
    return result.contents[0] as { mimeType?: string; text?: string; blob?: string };
}

type StubOptions = {
    datasets?: { items: { id: string; name?: string; itemCount: number }[] };
    stores?: { items: { id: string; name?: string }[] };
    listItems?: (...args: unknown[]) => unknown;
    listKeys?: (...args: unknown[]) => unknown;
    getRecord?: (...args: unknown[]) => unknown;
    getRecordPublicUrl?: (...args: unknown[]) => unknown;
    getStore?: (...args: unknown[]) => unknown;
};

function stubApifyClient(opts: StubOptions = {}): ApifyClient {
    return {
        datasets: () => ({ list: async () => opts.datasets ?? { items: [] } }),
        keyValueStores: () => ({ list: async () => opts.stores ?? { items: [] } }),
        dataset: (_id: string) => ({
            listItems: opts.listItems ?? (async () => ({ items: [], total: 0 })),
        }),
        keyValueStore: (id: string) => ({
            listKeys: opts.listKeys ?? (async () => ({ count: 0, items: [], isTruncated: false })),
            getRecord: opts.getRecord ?? (async () => undefined),
            getRecordPublicUrl:
                opts.getRecordPublicUrl ??
                (async (key: string) => `https://api.apify.com/v2/key-value-stores/${id}/records/${key}`),
            get: opts.getStore ?? (async () => ({ id })),
        }),
    } as unknown as ApifyClient;
}

function notFoundError() {
    return Object.assign(new Error('not found'), { statusCode: 404 });
}

describe('STORAGE_RESOURCE_TEMPLATES', () => {
    it('exposes the three storage templates', () => {
        expect(STORAGE_RESOURCE_TEMPLATES.map((t) => t.uriTemplate)).toEqual([
            'apify://datasets/{datasetId}/items{?offset,limit,fields,omit,clean,desc}',
            'apify://key-value-stores/{keyValueStoreId}/keys{?exclusiveStartKey,limit}',
            'apify://key-value-stores/{keyValueStoreId}/records/{recordKey}',
        ]);
    });
});

describe('isStorageUri()', () => {
    it('returns true for apify:// URIs', () => {
        expect(isStorageUri('apify://datasets/ds-1/items')).toBe(true);
    });

    it('returns false for other schemes', () => {
        expect(isStorageUri('file://readme.md')).toBe(false);
        expect(isStorageUri('ui://widget/search.html')).toBe(false);
    });
});

describe('listStorageResources()', () => {
    it('returns [] when there is no client', async () => {
        expect(await listStorageResources(undefined)).toEqual([]);
    });

    it('maps recent datasets and stores to concrete URIs', async () => {
        const client = stubApifyClient({
            datasets: { items: [{ id: 'ds-1', name: 'my-dataset', itemCount: 5 }] },
            stores: { items: [{ id: 'kv-1', name: 'my-store' }] },
        });

        const resources = await listStorageResources(client);

        expect(resources).toEqual([
            {
                uri: 'apify://datasets/ds-1/items',
                name: 'my-dataset',
                description: 'Dataset with 5 item(s).',
                mimeType: 'application/json',
            },
            {
                uri: 'apify://key-value-stores/kv-1/keys',
                name: 'my-store',
                description: 'Key-value store.',
                mimeType: 'application/json',
            },
        ]);
    });

    it('falls back to the id when a dataset has no name', async () => {
        const client = stubApifyClient({ datasets: { items: [{ id: 'ds-2', itemCount: 0 }] } });

        const [resource] = await listStorageResources(client);

        expect(resource.name).toBe('ds-2');
    });

    it('returns [] when the API throws', async () => {
        const client = {
            datasets: () => ({
                list: async () => {
                    throw new Error('boom');
                },
            }),
            keyValueStores: () => ({
                list: async () => {
                    throw new Error('boom');
                },
            }),
        } as unknown as ApifyClient;

        expect(await listStorageResources(client)).toEqual([]);
    });
});

describe('readStorageResource()', () => {
    it('returns an explanatory text block when there is no token', async () => {
        const result = await readStorageResource('apify://datasets/ds-1/items', undefined);

        expect(firstContent(result).mimeType).toBe('text/plain');
        expect(firstContent(result).text).toContain('no Apify token');
    });

    it('returns an explanatory text block for an unrecognized apify:// URI', async () => {
        const result = await readStorageResource('apify://unknown/thing', stubApifyClient());

        expect(firstContent(result).text).toContain('not a recognized Apify storage URI');
    });

    describe('dataset items', () => {
        it('shapes items into a JSON contents block with pagination', async () => {
            const client = stubApifyClient({
                listItems: async () => ({ items: [{ a: 1 }, { a: 2 }], total: 10 }),
            });

            const result = await readStorageResource('apify://datasets/ds-1/items?offset=2&limit=2', client);

            expect(firstContent(result).mimeType).toBe('application/json');
            const payload = JSON.parse(firstContent(result).text as string);
            expect(payload).toEqual({
                datasetId: 'ds-1',
                items: [{ a: 1 }, { a: 2 }],
                itemCount: 2,
                totalItemCount: 10,
                offset: 2,
                limit: 2,
            });
        });

        it('passes query options through to listItems', async () => {
            let received: Record<string, unknown> | undefined;
            const client = stubApifyClient({
                listItems: async (...args: unknown[]) => {
                    received = args[0] as Record<string, unknown>;
                    return { items: [], total: 0 };
                },
            });

            await readStorageResource(
                'apify://datasets/ds-1/items?fields=metadata.url,title&omit=junk&clean=true&desc=1',
                client,
            );

            expect(received).toMatchObject({
                fields: ['metadata.url', 'title'],
                omit: ['junk'],
                clean: true,
                desc: true,
                flatten: ['metadata'],
            });
        });

        it('returns a not-found text block when listItems 404s', async () => {
            const client = stubApifyClient({
                listItems: async () => {
                    throw notFoundError();
                },
            });

            const result = await readStorageResource('apify://datasets/missing/items', client);

            expect(firstContent(result).text).toContain("Dataset 'missing' not found");
        });

        it('rethrows non-404 errors from listItems', async () => {
            const serverError = Object.assign(new Error('boom'), { statusCode: 500 });
            const client = stubApifyClient({
                listItems: async () => {
                    throw serverError;
                },
            });

            await expect(readStorageResource('apify://datasets/ds-1/items', client)).rejects.toBe(serverError);
        });
    });

    describe('key listing', () => {
        it('shapes keys into a JSON contents block', async () => {
            const client = stubApifyClient({
                listKeys: async () => ({ count: 1, items: [{ key: 'INPUT', size: 12 }], isTruncated: false }),
            });

            const result = await readStorageResource('apify://key-value-stores/kv-1/keys?limit=10', client);

            expect(firstContent(result).mimeType).toBe('application/json');
            const payload = JSON.parse(firstContent(result).text as string);
            expect(payload.keyValueStoreId).toBe('kv-1');
            expect(payload.items).toEqual([{ key: 'INPUT', size: 12 }]);
        });

        it('returns a not-found text block when listKeys 404s', async () => {
            const client = stubApifyClient({
                listKeys: async () => {
                    throw notFoundError();
                },
            });

            const result = await readStorageResource('apify://key-value-stores/missing/keys', client);

            expect(firstContent(result).text).toContain("Key-value store 'missing' not found");
        });
    });

    describe('records', () => {
        it('returns a JSON value with its contentType', async () => {
            const client = stubApifyClient({
                getRecord: async () => ({ key: 'INPUT', value: { query: 'hi' }, contentType: 'application/json' }),
            });

            const result = await readStorageResource('apify://key-value-stores/kv-1/records/INPUT', client);

            expect(firstContent(result).mimeType).toBe('application/json');
            expect(JSON.parse(firstContent(result).text as string)).toEqual({ query: 'hi' });
        });

        it('returns a text value verbatim with its contentType', async () => {
            const client = stubApifyClient({
                getRecord: async () => ({ key: 'NOTE', value: 'hello world', contentType: 'text/plain' }),
            });

            const result = await readStorageResource('apify://key-value-stores/kv-1/records/NOTE', client);

            expect(firstContent(result).mimeType).toBe('text/plain');
            expect(firstContent(result).text).toBe('hello world');
        });

        it('returns binary values as a base64 blob with mimeType', async () => {
            const client = stubApifyClient({
                getRecord: async () => ({
                    key: 'IMG',
                    value: Buffer.from('binary-data'),
                    contentType: 'image/png',
                }),
            });

            const result = await readStorageResource('apify://key-value-stores/kv-1/records/IMG', client);

            const contents = firstContent(result);
            expect(contents.mimeType).toBe('image/png');
            expect(contents.blob).toBe(Buffer.from('binary-data').toString('base64'));
            expect(contents).not.toHaveProperty('text');
        });

        it('returns a public-URL link instead of inlining a binary above the size limit', async () => {
            // Inlining a multi-MB blob as base64 would blow up the client's context; link out instead.
            const oversized = Buffer.alloc(KV_RECORD_MAX_INLINE_BYTES + 1);
            const client = stubApifyClient({
                getRecord: async () => ({ key: 'BIG', value: oversized, contentType: 'application/octet-stream' }),
                getRecordPublicUrl: async (...args: unknown[]) =>
                    `https://api.apify.com/v2/key-value-stores/kv-1/records/${args[0] as string}?signature=abc`,
            });

            const result = await readStorageResource('apify://key-value-stores/kv-1/records/BIG', client);

            const contents = firstContent(result);
            expect(contents.mimeType).toBe('application/json');
            expect(contents).not.toHaveProperty('blob');
            expect(JSON.parse(contents.text as string)).toEqual({
                recordKey: 'BIG',
                size: KV_RECORD_MAX_INLINE_BYTES + 1,
                mimeType: 'application/octet-stream',
                recordPublicUrl: 'https://api.apify.com/v2/key-value-stores/kv-1/records/BIG?signature=abc',
            });
        });

        it('returns empty text for a record with an empty body', async () => {
            // apify-client maps an empty record body to `undefined` (e.g. an Actor that writes an empty OUTPUT).
            const client = stubApifyClient({
                getRecord: async () => ({ key: 'OUTPUT', value: undefined, contentType: 'application/json' }),
            });

            const result = await readStorageResource('apify://key-value-stores/kv-1/records/OUTPUT', client);

            expect(firstContent(result).text).toBe('');
            expect(firstContent(result)).not.toHaveProperty('blob');
        });

        it('URL-decodes the record key before lookup', async () => {
            let receivedKey: string | undefined;
            const client = stubApifyClient({
                getRecord: async (...args: unknown[]) => {
                    const key = args[0] as string;
                    receivedKey = key;
                    return { key, value: 'x', contentType: 'text/plain' };
                },
            });

            await readStorageResource('apify://key-value-stores/kv-1/records/data%2Ffile.json', client);

            expect(receivedKey).toBe('data/file.json');
        });

        it('distinguishes missing record from missing store', async () => {
            const missingRecord = stubApifyClient({
                getRecord: async () => undefined,
                getStore: async () => ({ id: 'kv-1' }),
            });
            const missingStore = stubApifyClient({
                getRecord: async () => undefined,
                getStore: async () => undefined,
            });

            const recordResult = await readStorageResource('apify://key-value-stores/kv-1/records/GONE', missingRecord);
            const storeResult = await readStorageResource('apify://key-value-stores/kv-9/records/GONE', missingStore);

            expect(firstContent(recordResult).text).toContain("Record 'GONE' not found");
            expect(firstContent(storeResult).text).toContain("Key-value store 'kv-9' not found");
        });
    });
});

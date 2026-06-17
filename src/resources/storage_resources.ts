import type {
    BlobResourceContents,
    ReadResourceResult,
    Resource,
    ResourceTemplate,
    TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js';

import type { ApifyClient } from '../apify_client.js';
import { HTTP_NOT_FOUND, KV_RECORD_MAX_INLINE_BYTES } from '../const.js';
import { extractDotPrefixes } from '../tools/common/get_dataset_items.js';
import { normalizeRecordKey } from '../tools/common/storage_helpers.js';
import { parseCommaSeparatedList, stripQuoteWrappers } from '../utils/generic.js';
import { getHttpStatusCode } from '../utils/logging.js';

/** Prefix for all storage resource URIs. */
const STORAGE_URI_PREFIX = 'apify://';
/** Max recent datasets / stores to surface in resources/list. */
const RECENT_LIST_LIMIT = 10;
/** Default page size for dataset items when the URI omits `limit`. */
const DEFAULT_DATASET_ITEMS_LIMIT = 20;
const JSON_MIME_TYPE = 'application/json';
const TEXT_MIME_TYPE = 'text/plain';

/**
 * The three storage resource templates returned by resources/templates/list.
 * RFC 6570 URI templates over the custom `apify://` scheme.
 */
export const STORAGE_RESOURCE_TEMPLATES: ResourceTemplate[] = [
    {
        uriTemplate: 'apify://datasets/{datasetId}/items{?offset,limit,fields,omit,clean,desc}',
        name: 'Dataset items',
        description: 'Items of an Apify dataset, paginated and field-selectable.',
        mimeType: JSON_MIME_TYPE,
    },
    {
        uriTemplate: 'apify://key-value-stores/{keyValueStoreId}/keys{?exclusiveStartKey,limit}',
        name: 'Key-value store keys',
        description: 'Keys in an Apify key-value store, cursor-paginated.',
        mimeType: JSON_MIME_TYPE,
    },
    {
        uriTemplate: 'apify://key-value-stores/{keyValueStoreId}/records/{recordKey}',
        name: 'Key-value store record',
        description: 'A single record (text, JSON, or binary) from an Apify key-value store.',
    },
];

/** True when the URI uses the `apify://` storage scheme. */
export function isStorageUri(uri: string): boolean {
    return uri.startsWith(STORAGE_URI_PREFIX);
}

/**
 * List the user's recent datasets and key-value stores as concrete resource URIs.
 * Best-effort: returns `[]` when there is no client or the API errors, so the
 * overall resources/list still serves widgets and the usage guide.
 */
export async function listStorageResources(apifyClient?: ApifyClient): Promise<Resource[]> {
    if (!apifyClient) {
        return [];
    }
    const resources: Resource[] = [];
    try {
        const datasets = await apifyClient.datasets().list({ limit: RECENT_LIST_LIMIT, desc: true });
        for (const dataset of datasets.items) {
            resources.push({
                uri: `apify://datasets/${dataset.id}/items`,
                name: dataset.name ?? dataset.id,
                description: `Dataset with ${dataset.itemCount} item(s).`,
                mimeType: JSON_MIME_TYPE,
            });
        }
    } catch {
        // Ignore: best-effort listing.
    }
    try {
        const stores = await apifyClient.keyValueStores().list({ limit: RECENT_LIST_LIMIT, desc: true });
        for (const store of stores.items) {
            resources.push({
                uri: `apify://key-value-stores/${store.id}/keys`,
                name: store.name ?? store.id,
                description: 'Key-value store.',
                mimeType: JSON_MIME_TYPE,
            });
        }
    } catch {
        // Ignore: best-effort listing.
    }
    return resources;
}

/** Single explanatory text-contents result for a not-found / no-token read. */
function buildTextResult(uri: string, text: string): ReadResourceResult {
    return { contents: [{ uri, mimeType: TEXT_MIME_TYPE, text } satisfies TextResourceContents] };
}

/** Parse a positive integer query param; returns undefined when absent or invalid. */
function parsePositiveInt(value: string | null): number | undefined {
    if (value === null) {
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        return undefined;
    }
    return parsed;
}

/** Parse a boolean query param (`true`/`1`); returns undefined when absent. */
function parseBool(value: string | null): boolean | undefined {
    if (value === null) {
        return undefined;
    }
    return value === 'true' || value === '1';
}

/**
 * Read an `apify://` storage resource into a ReadResourceResult.
 *
 * Parses the URI by stripping the `apify://` prefix, splitting the path on `/`,
 * and reading the query with URLSearchParams (avoids `new URL()` host-vs-path quirks).
 * Not-found and no-token cases return an explanatory text block rather than throwing.
 */
export async function readStorageResource(uri: string, apifyClient?: ApifyClient): Promise<ReadResourceResult> {
    if (!apifyClient) {
        return buildTextResult(uri, `Cannot read ${uri}: no Apify token in this session.`);
    }

    const withoutPrefix = uri.slice(STORAGE_URI_PREFIX.length);
    const [pathPart, queryPart] = withoutPrefix.split('?');
    const segments = pathPart.split('/').filter((s) => s.length > 0);
    const query = new URLSearchParams(queryPart ?? '');

    // apify://datasets/{datasetId}/items
    if (segments[0] === 'datasets' && segments[2] === 'items' && segments.length === 3) {
        return readDatasetItems(uri, apifyClient, decodeURIComponent(segments[1]), query);
    }

    // apify://key-value-stores/{keyValueStoreId}/keys
    if (segments[0] === 'key-value-stores' && segments[2] === 'keys' && segments.length === 3) {
        return readKeyValueStoreKeys(uri, apifyClient, decodeURIComponent(segments[1]), query);
    }

    // apify://key-value-stores/{keyValueStoreId}/records/{recordKey}
    if (segments[0] === 'key-value-stores' && segments[2] === 'records' && segments.length === 4) {
        return readKeyValueStoreRecord(
            uri,
            apifyClient,
            decodeURIComponent(segments[1]),
            decodeURIComponent(segments[3]),
        );
    }

    return buildTextResult(uri, `Resource ${uri} is not a recognized Apify storage URI.`);
}

async function readDatasetItems(
    uri: string,
    apifyClient: ApifyClient,
    rawDatasetId: string,
    query: URLSearchParams,
): Promise<ReadResourceResult> {
    const datasetId = stripQuoteWrappers(rawDatasetId);
    const fields = parseCommaSeparatedList(query.get('fields') ?? undefined);
    const omit = parseCommaSeparatedList(query.get('omit') ?? undefined);
    const limit = parsePositiveInt(query.get('limit')) ?? DEFAULT_DATASET_ITEMS_LIMIT;
    const offset = parsePositiveInt(query.get('offset')) ?? 0;

    // `listItems()` throws ApifyApiError on a missing dataset (only `.get()` soft-catches 404),
    // so translate 404 into a soft not-found, mirroring the get-dataset-items tool.
    const result = await apifyClient
        .dataset(datasetId)
        .listItems({
            clean: parseBool(query.get('clean')),
            offset,
            limit,
            fields,
            omit,
            desc: parseBool(query.get('desc')),
            flatten: extractDotPrefixes(fields),
        })
        .catch((err: unknown) => {
            if (getHttpStatusCode(err) === HTTP_NOT_FOUND) {
                return null;
            }
            throw err;
        });
    if (!result) {
        return buildTextResult(uri, `Dataset '${datasetId}' not found.`);
    }

    const payload = {
        datasetId,
        items: result.items,
        itemCount: result.items.length,
        totalItemCount: result.total,
        offset,
        limit,
    };
    return {
        contents: [{ uri, mimeType: JSON_MIME_TYPE, text: JSON.stringify(payload) } satisfies TextResourceContents],
    };
}

async function readKeyValueStoreKeys(
    uri: string,
    apifyClient: ApifyClient,
    rawStoreId: string,
    query: URLSearchParams,
): Promise<ReadResourceResult> {
    const keyValueStoreId = stripQuoteWrappers(rawStoreId);
    const limit = parsePositiveInt(query.get('limit'));
    const exclusiveStartKey = query.get('exclusiveStartKey') ?? undefined;

    // `listKeys()` throws ApifyApiError on a missing store (only `.get()`/`.getRecord()` soft-catch 404).
    const keys = await apifyClient
        .keyValueStore(keyValueStoreId)
        .listKeys({ exclusiveStartKey, limit })
        .catch((err: unknown) => {
            if (getHttpStatusCode(err) === HTTP_NOT_FOUND) {
                return null;
            }
            throw err;
        });
    if (!keys) {
        return buildTextResult(uri, `Key-value store '${keyValueStoreId}' not found.`);
    }

    return {
        contents: [
            {
                uri,
                mimeType: JSON_MIME_TYPE,
                text: JSON.stringify({ keyValueStoreId, ...keys }),
            } satisfies TextResourceContents,
        ],
    };
}

async function readKeyValueStoreRecord(
    uri: string,
    apifyClient: ApifyClient,
    rawStoreId: string,
    rawRecordKey: string,
): Promise<ReadResourceResult> {
    const keyValueStoreId = stripQuoteWrappers(rawStoreId);
    const recordKey = normalizeRecordKey(rawRecordKey);
    const store = apifyClient.keyValueStore(keyValueStoreId);
    const record = await store.getRecord(recordKey);
    if (record === undefined) {
        // getRecord returns undefined for both missing-store and missing-key; disambiguate via .get().
        const storeInfo = await store.get();
        const text = storeInfo
            ? `Record '${recordKey}' not found in key-value store '${keyValueStoreId}'.`
            : `Key-value store '${keyValueStoreId}' not found.`;
        return buildTextResult(uri, text);
    }

    // The SDK already parsed the body by Content-Type (JSON -> object, text/xml -> string, else -> Buffer);
    // branch on the resulting JS type, not on the MIME type.
    const { value, contentType } = record;
    // apify-client maps an empty record body to `undefined`; emit empty text (an empty OUTPUT is legitimate).
    if (value === undefined) return buildTextResult(uri, '');
    if (Buffer.isBuffer(value)) {
        const mimeType = contentType?.split(';')[0].trim().toLowerCase();
        // Inlining a large binary as base64 would blow up the client's context, so above the inline limit
        // link out to the record instead — mirroring the get-key-value-store-record tool. resources/read has
        // no resource_link content type, so the link rides in a JSON text block carrying the same fields.
        if (value.length > KV_RECORD_MAX_INLINE_BYTES) {
            const recordPublicUrl = await store.getRecordPublicUrl(recordKey);
            return {
                contents: [
                    {
                        uri,
                        mimeType: JSON_MIME_TYPE,
                        text: JSON.stringify({
                            recordKey,
                            size: value.length,
                            ...(mimeType && { mimeType }),
                            recordPublicUrl,
                        }),
                    } satisfies TextResourceContents,
                ],
            };
        }
        return {
            contents: [
                {
                    uri,
                    ...(mimeType && { mimeType }),
                    blob: value.toString('base64'),
                } satisfies BlobResourceContents,
            ],
        };
    }

    // Text/JSON values: a string is emitted verbatim with its declared contentType; anything else is
    // lossless-serialized as JSON.
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return {
        contents: [
            {
                uri,
                mimeType: contentType ?? (typeof value === 'string' ? TEXT_MIME_TYPE : JSON_MIME_TYPE),
                text,
            } satisfies TextResourceContents,
        ],
    };
}

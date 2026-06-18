import type {
    BlobResourceContents,
    ReadResourceResult,
    Resource,
    ResourceTemplate,
    TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js';

import type { ApifyClient } from '../apify_client.js';
import { getApifyAPIBaseUrl } from '../apify_client.js';
import { KV_RECORD_MAX_INLINE_BYTES } from '../const.js';
import { getHttpStatusCode } from '../utils/logging.js';

/** Max recent datasets / stores to surface in resources/list. */
const RECENT_LIST_LIMIT = 10;
/** Default page size baked into the advertised dataset-items URI so a naive read doesn't pull a whole dataset. */
const DEFAULT_DATASET_ITEMS_LIMIT = 20;
const JSON_MIME_TYPE = 'application/json';
const TEXT_MIME_TYPE = 'text/plain';

/**
 * Resource templates returned by resources/templates/list, expressed as real Apify API
 * GET URLs (RFC 6570 templates). The read path is a generic proxy over any Apify API GET
 * endpoint, so these are just the common, discoverable starting points — not an exhaustive list.
 */
export const API_RESOURCE_TEMPLATES: ResourceTemplate[] = [
    {
        uriTemplate: `${getApifyAPIBaseUrl()}/v2/datasets/{datasetId}/items{?format,clean,offset,limit,fields,omit,desc}`,
        name: 'Dataset items',
        description: 'Items of an Apify dataset, paginated and field-selectable.',
        mimeType: JSON_MIME_TYPE,
    },
    {
        uriTemplate: `${getApifyAPIBaseUrl()}/v2/key-value-stores/{keyValueStoreId}/keys{?exclusiveStartKey,limit}`,
        name: 'Key-value store keys',
        description: 'Keys in an Apify key-value store, cursor-paginated.',
        mimeType: JSON_MIME_TYPE,
    },
    {
        uriTemplate: `${getApifyAPIBaseUrl()}/v2/key-value-stores/{keyValueStoreId}/records/{recordKey}`,
        name: 'Key-value store record',
        description: 'A single record (text, JSON, or binary) from an Apify key-value store.',
    },
];

/**
 * True when the URI is an Apify API URL (same origin as the configured API base).
 *
 * This is the security gate for the generic read proxy: the apify-client attaches the
 * session token as an `Authorization` header to every outbound request, so we must only
 * hand it Apify API URLs — never an arbitrary host.
 */
export function isApifyApiUri(uri: string): boolean {
    try {
        return new URL(uri).origin === new URL(getApifyAPIBaseUrl()).origin;
    } catch {
        return false;
    }
}

/**
 * List the user's recent datasets and key-value stores as concrete Apify API URLs.
 * Best-effort: returns `[]` when there is no client or the API errors, so the overall
 * resources/list still serves widgets and the usage guide.
 */
export async function listStorageResources(apifyClient?: ApifyClient): Promise<Resource[]> {
    if (!apifyClient) {
        return [];
    }
    const base = getApifyAPIBaseUrl();
    const resources: Resource[] = [];
    try {
        const datasets = await apifyClient.datasets().list({ limit: RECENT_LIST_LIMIT, desc: true });
        for (const dataset of datasets.items) {
            resources.push({
                uri: `${base}/v2/datasets/${dataset.id}/items?limit=${DEFAULT_DATASET_ITEMS_LIMIT}`,
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
                uri: `${base}/v2/key-value-stores/${store.id}/keys`,
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

/** Matches an Apify key-value-store record path, capturing the store id and the record key. */
const KV_RECORD_PATH_RE = /^\/v2\/key-value-stores\/([^/]+)\/records\/(.+)$/;

/**
 * Download URL for a binary too large to inline. For a key-value-store record URI, returns the
 * store's signed `recordPublicUrl` — fetchable without an API token when the client can read the
 * store's URL signing key. Falls back to the original API URL for any other endpoint, or if minting
 * the signed URL fails (fetching that link then needs a token).
 */
async function getRecordDownloadUrl(uri: string, apifyClient: ApifyClient): Promise<string> {
    let pathname: string;
    try {
        pathname = new URL(uri).pathname;
    } catch {
        return uri;
    }
    const match = KV_RECORD_PATH_RE.exec(pathname);
    if (!match) return uri;
    try {
        const store = apifyClient.keyValueStore(decodeURIComponent(match[1]));
        return await store.getRecordPublicUrl(decodeURIComponent(match[2]));
    } catch {
        return uri;
    }
}

/** Single explanatory text-contents result for a not-found / no-token / refused read. */
function buildTextResult(uri: string, text: string): ReadResourceResult {
    return { contents: [{ uri, mimeType: TEXT_MIME_TYPE, text } satisfies TextResourceContents] };
}

/**
 * Read any Apify API GET endpoint as an MCP resource.
 *
 * A thin proxy: the apify-client injects the session token (and MCP-origin / payment headers),
 * performs the GET, and parses the body by Content-Type — JSON to an object, text/xml to a
 * string, anything else to a Buffer, an empty body to `undefined`. We branch on that resulting
 * JS type, not the MIME type. Errors (a missing resource, a bad token, a 5xx) never throw; they
 * return an explanatory text block, matching the resources/read soft-fail contract.
 */
export async function readApiResource(uri: string, apifyClient?: ApifyClient): Promise<ReadResourceResult> {
    if (!apifyClient) {
        return buildTextResult(uri, `Cannot read ${uri}: no Apify token in this session.`);
    }
    if (!isApifyApiUri(uri)) {
        return buildTextResult(
            uri,
            `Cannot read ${uri}: only Apify API URLs (${getApifyAPIBaseUrl()}) are readable as resources.`,
        );
    }

    let response: { data: unknown; headers: Record<string, unknown> };
    try {
        // Default responseType is `arraybuffer`, which lets the client's parse interceptor decode
        // the body by Content-Type. Do NOT set `forceBuffer` — that would keep everything as raw bytes.
        response = await apifyClient.httpClient.call({ url: uri, method: 'GET', responseType: 'arraybuffer' });
    } catch (err) {
        const status = getHttpStatusCode(err);
        const message = err instanceof Error ? err.message : String(err);
        return buildTextResult(uri, `Failed to read ${uri}: ${status ? `HTTP ${status}: ` : ''}${message}`);
    }

    const contentTypeHeader = response.headers['content-type'];
    const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader : undefined;
    const { data } = response;

    // An empty body (e.g. an Actor that wrote an empty OUTPUT) is legitimate; emit empty text.
    if (data === undefined || data === null) {
        return buildTextResult(uri, '');
    }

    if (Buffer.isBuffer(data)) {
        const mimeType = contentType?.split(';')[0].trim().toLowerCase();
        // Inlining a large binary as base64 would blow up the client's context, so above the inline
        // limit link out instead: a JSON text block with the URL, size, and type (resources/read has
        // no resource_link content type). For a key-value-store record the link is the signed public
        // URL, fetchable without a token; other endpoints fall back to the (token-gated) API URL.
        if (data.length > KV_RECORD_MAX_INLINE_BYTES) {
            const downloadUrl = await getRecordDownloadUrl(uri, apifyClient);
            return {
                contents: [
                    {
                        uri,
                        mimeType: JSON_MIME_TYPE,
                        text: JSON.stringify({ uri: downloadUrl, size: data.length, ...(mimeType && { mimeType }) }),
                    } satisfies TextResourceContents,
                ],
            };
        }
        return {
            contents: [
                { uri, ...(mimeType && { mimeType }), blob: data.toString('base64') } satisfies BlobResourceContents,
            ],
        };
    }

    // JSON (already parsed to an object/array) or text/xml (a string). A string is emitted verbatim
    // with its declared Content-Type; anything else is lossless-serialized as JSON.
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return {
        contents: [
            {
                uri,
                mimeType: contentType ?? (typeof data === 'string' ? TEXT_MIME_TYPE : JSON_MIME_TYPE),
                text,
            } satisfies TextResourceContents,
        ],
    };
}

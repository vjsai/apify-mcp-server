<!-- agents-scope: src/resources -->
# src/resources — MCP resources + widget registry

↑ [src/](../AGENTS.md) · sideways: [`../web/AGENTS.md`](../web/AGENTS.md)

Three files serving the MCP `resources/*` surface:

- `resource_service.ts` — handles `ListResources` / `ListResourceTemplates` /
  read-resource requests. Takes an optional `apifyClient` on list/read; the server
  builds it from the per-request token (`_meta.apifyToken || options.token`).
- `storage_resources.ts` — exposes Apify storage **data reads** as resources
  (alongside, not replacing, the storage tools).
- `widgets.ts` — the registry of UI widgets (the metadata that maps a widget name to
  its resource); the widgets themselves are built in [`../web`](../web/AGENTS.md).

## Storage resources (`storage_resources.ts`)

Custom `apify://` scheme, parsed by stripping the prefix, splitting the path on `/`,
and reading the query with `URLSearchParams` (the `recordKey` is URL-decoded). Three
templates (`resources/templates/list`):

- `apify://datasets/{datasetId}/items{?offset,limit,fields,omit,clean,desc}` — dataset items
- `apify://key-value-stores/{keyValueStoreId}/keys{?exclusiveStartKey,limit}` — KVS key listing
- `apify://key-value-stores/{keyValueStoreId}/records/{recordKey}` — a single KVS record

`resources/list` adds concrete URIs for the user's recent datasets/stores
(`desc: true`, bounded). Contents are `application/json` for items/keys; records keep
their `contentType` (binary → base64 `blob`). A binary record over
`KV_RECORD_MAX_INLINE_BYTES` (256 KB) links out instead of inlining: a JSON text block
with the record's public URL (`resources/read` has no `resource_link` content type),
mirroring the `get-key-value-store-record` tool. Best-effort: no token / API error →
list omits storage; an unreadable read returns an explanatory `text` block, never an
error. Reuses the storage tools' arg-parsing helpers and 404→soft-fail pattern; it
does **not** share their response builders (resources need `ReadResourceResult`).

## Gotcha

`widgets.ts` is **metadata only** — it registers and locates widgets. The actual
React widget code and design rules live in [`../web/AGENTS.md`](../web/AGENTS.md);
keep the two in sync (a widget registered here must exist there, and vice versa).

After any change here run the root [Verification](../../AGENTS.md) steps.

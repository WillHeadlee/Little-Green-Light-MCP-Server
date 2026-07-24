# `search_constituents_advanced` — Design Spec

**Date:** 2026-07-23
**Status:** Approved for planning

## Problem

LGL's `/constituents/search` endpoint supports rich server-side filtering via a `q[]` query DSL — including a `custom_attr` field token with `blank`/`not_blank` operators — but nothing in this MCP server exposes it. The only tool that comes close, `constituents_missing_info` (index.js:2730), fakes "missing info" by fetching up to 500 constituents and filtering client-side, which doesn't scale and can't see custom attributes at all.

This spec adds a new tool, `search_constituents_advanced`, that builds real `q[]` filters from friendly, structured inputs.

## Confirmed LGL API behavior

Verified live against the production API this session (not just documentation):

- Query params are `q[]=<field_token>=<value>`; multiple `q[]` entries **AND** together.
- Custom attribute text filtering: `q[]=custom_attr=<key>|<op>|<value>` where `op` is one of `ft` (contains), `nft` (not contains), `eq` (equals), `ne` (not equals), `sw` (starts with), `bl` (blank), `nb` (not blank).
- **Quirk confirmed by live testing:** the API requires a non-empty 3rd pipe segment even for `bl`/`nb`, where the value is semantically ignored. `q[]=custom_attr=background_info|bl` and `...|bl|` (empty) both 400 with `Parameter Error`; `...|bl|x` succeeds. The tool must always send a placeholder value for blank/not-blank.
- `key` in `custom_attr=<key>|...` is the attribute's `key` field from `GET /attributes` (e.g. `"background_info"`), **not** its `name` (`"Background Info"`) or `id`.
- Numeric (`custom_attr_int`) and date (`custom_attr_from`/`custom_attr_to`) attribute filtering exist in LGL's docs but are **out of scope** for this tool per user decision — this account has no numeric/date custom attributes to verify against, and the immediate need is text attributes with blank/not-blank.
- Standard field tokens confirmed from LGL's docs: `name`, `eaddr`, `phone_number`, `street`, `city`, `state`, `postal_code`, `country`, `keyword` (single ID, not comma-separated), `updated_from`/`updated_to` (`YYYY-MM-DDTHH:MM:SSZ`), `membership_status` (0=lapsed, 1=active), `membership_level` (comma-separated IDs), `membership_end_date_from`/`_to`, `external_id`, `constituent_type` (0=individual, 1=organization), `groups` (comma-separated IDs), `lists` (comma-separated IDs).
- `/keywords` has no flat "list all" endpoint, but `GET /categories` already nests each category's keywords inline (confirmed live — every category in a 3-category test account returned a populated `keywords` array). Resolving a keyword by name is therefore one `GET /categories` call flattened, not a fan-out to `/categories/{id}/keywords` per category as originally assumed.
- **`/constituents/search` results omit `custom_attrs` by default** — confirmed live: a search result item has none of the custom-attribute fields present on a single `GET /constituents/{id}` record. Adding `expand=custom_attrs` to the search request restores it (confirmed live: same query with `expand=custom_attrs` returns `"custom_attrs": []` on each item). **Revised after real usage:** filtering ON a custom attribute (via `q[]=custom_attr=...`) works independently of `expand` — the tool originally sent `expand=custom_attrs` unconditionally, which meant every result (even ones matched on name/city/whatever) carried full attribute values, including long text fields, even when nothing asked for them. `expand` is now gated behind an explicit `include_custom_attrs` input, off by default.
- **`bl`/`nb` only match constituents that have a row for the attribute at all** — confirmed live (see the account note above): both operators returned zero matches when no constituent had ever had the attribute touched. So "blank" (a row exists, value is empty) and "never touched" (no row exists) are different states that LGL's own operators cannot distinguish between via a single query. A "never touched" tool has to diff the full constituent ID set against the union of blank+not_blank matches; see `constituents_never_touched_attribute` below.

## Tool interface

```
search_constituents_advanced({
  query?: string,                 // free text; reuses constituentSearchExpr (name/email/phone routing)
  include_custom_attrs?: boolean, // default false — fetch each result's custom attribute values; filtering on custom_attributes does NOT require this

  custom_attributes?: [
    // Shape A — blank checks take no value (schema-enforced via oneOf, not a runtime check)
    { name: string, operator: "blank" | "not_blank" }
    // Shape B — every other operator requires one
    | { name: string, operator: "contains" | "not_contains" | "equals" | "not_equals" | "starts_with", value: string }
  ],

  keyword?: string,                       // name, not ID
  city?: string, state?: string, postal_code?: string, country?: string,
  constituent_type?: "individual" | "organization",
  membership_status?: "active" | "lapsed",
  membership_level_names?: string[],      // names, not IDs
  membership_end_date_from?: string, membership_end_date_to?: string,  // YYYY-MM-DD
  updated_from?: string, updated_to?: string,                          // YYYY-MM-DD, normalized to T00:00:00Z
  group_names?: string[],                 // names, not IDs
  list_names?: string[],                  // names, not IDs
  external_id?: string,

  limit?: number (default 20),
  offset?: number (default 0),
})
```

`custom_attributes` items use JSON Schema `oneOf` with `additionalProperties: false` on each branch, so a well-behaved MCP client sees two distinct valid shapes rather than one shape plus a hidden rule. **Confirmed during implementation testing:** the `@modelcontextprotocol/sdk` server does not itself validate call arguments against `inputSchema` before invoking the handler — a client that ignores the schema can still send `{operator: "blank", value: "x"}`. The handler therefore also enforces the same two-shape constraint at runtime (unknown operator, blank/not_blank with a value, or a non-blank operator missing a value all throw a clear error) rather than relying on the schema alone.

## Name resolution and caching

LGL has no "resolve name → id/key" endpoint, so every name-based filter (`custom_attributes[].name`, `keyword`, `membership_level_names`, `group_names`, `list_names`) needs one lookup somewhere. To avoid paying that cost on every single call, the server keeps a lazily-populated, module-level in-memory cache that lives for the process's lifetime (the MCP server is a long-running stdio process, resident across every tool call in a session — not restarted per request):

```js
const referenceCache = {}; // keyed by reference type

async function getReferenceList(key, fetcher) {
  if (!referenceCache[key]) referenceCache[key] = await fetcher();
  return referenceCache[key];
}

async function resolveByName(key, fetcher, name, { nameField = "name", valueField = "id" } = {}) {
  let list = await getReferenceList(key, fetcher);
  let match = list.find(i => i[nameField]?.toLowerCase() === name.toLowerCase());
  if (!match) {                  // self-heal: might have just been added in LGL's UI
    delete referenceCache[key];
    list = await getReferenceList(key, fetcher);
    match = list.find(i => i[nameField]?.toLowerCase() === name.toLowerCase());
  }
  if (!match) {
    throw new Error(`No ${key} named "${name}". Available: ${list.map(i => i[nameField]).join(", ")}`);
  }
  return match[valueField];
}
```

Reference types and their fetchers:

| Cache key | Fetcher | Notes |
|---|---|---|
| `custom_attributes` | `GET /attributes` | nameField `name`, valueField `key` |
| `groups` | `GET /groups?limit=200` | nameField/valueField default (`name`/`id`) |
| `lists` | `GET /lists` | default |
| `membership_levels` | `GET /membership_levels` | default |
| `keywords` | `GET /categories?limit=200`, flatMap over each category's inline `keywords` array | default; single request, no fan-out needed |

No TTL: the cache lives for the server process's lifetime, and a resolution miss triggers exactly one refetch-and-retry before erroring out. Net effect: the first call in a session that references a given name pays one lookup; every later call (same or different name of the same reference type) is a free in-memory `.find()`.

## Query building

0. Add `expand=custom_attrs` to the search request only when `include_custom_attrs` is true — filtering on `custom_attributes` does not require it, so it stays off by default to keep responses small.
1. If `query` is provided, add `q[]=<constituentSearchExpr(query)>`.
2. For each `custom_attributes` entry: resolve `name` → `key` via the cache, map the friendly operator to LGL's op code, and emit `q[]=custom_attr=<key>|<op>|<value ?? "_">` (placeholder `"_"` when no value, i.e. blank/not_blank).
3. Standard fields map directly to their documented tokens; `constituent_type`/`membership_status` translate their enum strings to 0/1 (matching the existing `create_constituent`/`update_constituent` translation pattern already in the file). Array-valued standard fields (`membership_level_names`, `group_names`, `list_names`) resolve each name to an ID via the cache and join with commas into a single `q[]` entry. `keyword` resolves to a single ID token (no comma-joining — LGL's docs describe this token as singular).
4. `updated_from`/`updated_to` accept a plain `YYYY-MM-DD` and are normalized to `T00:00:00Z` before being sent, matching LGL's documented `YYYY-MM-DDTHH:MM:SSZ` format.
5. Every filter present becomes one `q[]` entry; LGL ANDs them all (confirmed live — no OR support exists, so none is implied).

## Response shape

Reuses `summaryConstituent` (index.js:288). When `include_custom_attrs` is true, adds the constituent's `custom_attrs` array (confirmed field name via a live record fetch) via a dedicated `summaryConstituentWithAttrs` wrapper — kept separate from `summaryConstituent` so existing tools' output is untouched. When `include_custom_attrs` is false (the default), results carry no `custom_attrs` field at all rather than a placeholder `[]`, so it's unambiguous that attribute data wasn't fetched.

## Companion tool: `constituents_never_touched_attribute`

`search_constituents_advanced`'s `blank` operator only matches constituents that *have* a row for the attribute whose value happens to be empty — it cannot see constituents that have never had the attribute touched at all (no row exists), per the confirmed `bl`/`nb` behavior above. There is no LGL query token for "attribute row does not exist," so finding these requires a diff:

1. Fetch the full constituent ID set (`/constituents/search` with no `q[]` filters, paginated).
2. Fetch the "touched" ID set: the union of `custom_attr=<key>|bl|_` and `custom_attr=<key>|nb|_` matches (each paginated) — together these are LGL's own server-side computation of every constituent that has a row for the attribute, regardless of its value.
3. `never_touched = all - touched`, computed locally as a `Set` difference (the only client-side step; everything upstream of it is LGL's own filtering).

All three fetches run in parallel via a shared `paginateConstituentSearch` helper (same bounded-pages-with-`truncated`-flag shape as the existing `paginateGifts`). Input is just `{ name: string, limit?: number }` — `name` resolves through the same custom-attribute cache as `search_constituents_advanced`. Output is `{ attribute, count, constituents }`, where `count` reflects the true total even when `constituents` is capped by `limit`, plus `truncated`/`note` if any underlying query hit its page cap.

## Error handling

- Unknown name for any name-based filter (`custom_attributes[].name`, `keyword`, `membership_level_names`, `group_names`, `list_names`): error message lists the actual available names for that reference type (same pattern as `resolveConstituentId`'s ambiguous-match error, index.js:333).
- No filters provided at all: same behavior as calling `/constituents/search` with no `q[]` — pass through whatever LGL returns rather than special-casing it.

## Out of scope (explicit)

- Numeric (`custom_attr_int`) and date (`custom_attr_from`/`custom_attr_to`) custom attribute filtering — dropped per user decision; can be added later behind the same `custom_attributes` array shape (a third `oneOf` branch) if a numeric/date attribute ever exists in this account to test against.
- OR logic between filters — not supported by LGL's `q[]` mechanism at all.
- Multi-keyword filtering — LGL's docs describe `keyword` as a single ID, unlike the explicitly-comma-separated `groups`/`lists`/`membership_level` tokens.

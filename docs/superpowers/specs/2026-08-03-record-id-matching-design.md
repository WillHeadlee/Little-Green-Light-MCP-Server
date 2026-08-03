# `record_id` Matching for Integration Queue Submissions — Design Spec

**Date:** 2026-08-03
**Status:** Approved for planning

## Problem

The five `submit_*_for_review` tools (index.js:1896–2055) post flat key/value fields to LGL's custom-integration webhook, which lands submissions in the Integration Queue for human approval. Matching a submission to an existing constituent currently relies only on LGL's "match on email address and name" rule via `MATCHING_PROPS` (`first_name`, `last_name`, `email`).

The code deliberately omits an LGL constituent ID match key: a prior comment (index.js:1888–1894) and README.md:111 both say mapping "LGL Constituent ID" in LGL's integration field mapping didn't persist when the integration's record-matching preference was set to email/name-based. The user has since switched that LGL-side setting to ID-based matching, and mapped a field named `record_id` to "LGL Constituent ID" in LGL's UI. The AI already has the LGL constituent ID on hand from prior lookups (`get_constituent`, `search_constituents`, `get_donor_context`, etc.), so it can now supply it directly for more reliable matching than name/email alone.

## Change

Add an optional `record_id` field, sent as-is to LGL (key name fixed by LGL's field mapping, not configurable here):

1. **`MATCHING_PROPS`** (index.js:233): add `record_id: { type: "string", description: "LGL constituent ID, for matching (preferred over name/email when known)" }`. Since `submit_gift_for_review`, `submit_note_for_review`, `submit_event_registration_for_review`, and `submit_appeal_request_for_review` all spread `...MATCHING_PROPS` and forward `args` verbatim to `postToIntegrationQueue`, this single addition wires all four through with no handler changes.
2. **`submit_constituent_for_review`** (index.js:1896): add the same `record_id` property directly to its own `inputSchema.properties` (it doesn't spread `MATCHING_PROPS` — it already has `first_name`/`last_name` for the constituent's own identity). Its handler forwards unknown scalars via `...scalars`, so no handler change is needed.
3. Update the five tool `description` strings to mention `record_id` as the preferred match key when known, name/email as fallback.
4. Update the stale caveat at index.js:1888–1894 and README.md:111 (Known Limitation) to reflect that ID-based matching is now configured and working, rather than instructing callers to omit it.

`record_id` is optional everywhere — submissions without it continue to match on name/email as before.

## Out of scope

- `postToIntegrationQueue`, `flattenSlots`, and permission/annotation logic are unaffected — they're already generic over field names.
- No change to which tools are gated by `LGL_READ_ONLY`/`LGL_ASSISTED_MODE`.

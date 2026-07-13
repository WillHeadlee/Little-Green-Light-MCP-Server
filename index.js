#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const LGL_BASE = "https://api.littlegreenlight.com/api/v1";
const API_KEY = process.env.LGL_API_KEY;

// ─── HTTP Requester ──────────────────────────────────────────────────────────

async function lglRequest(method, path, body) {
  if (!API_KEY) {
    throw new Error("LGL_API_KEY is not set. Please configure it in your environment/mcp config.");
  }

  // Ensure path starts with a slash and does not duplicate /api/v1
  let cleanPath = path;
  if (!cleanPath.startsWith("/")) {
    cleanPath = "/" + cleanPath;
  }
  if (cleanPath.startsWith("/api/v1")) {
    cleanPath = cleanPath.substring(7);
  }

  const url = `${LGL_BASE}${cleanPath}`;
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
  };
  if (body && (method === "POST" || method === "PATCH")) {
    options.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    throw new Error(`Could not reach LGL API: ${err.message}. Check your internet connection.`);
  }

  if (res.status === 401) throw new Error("LGL API key is invalid or missing — check your configuration");
  if (res.status === 403) throw new Error("Access denied — check API key permissions");
  if (res.status === 404) throw new Error(`Record or path not found: ${cleanPath}`);
  if (res.status === 429) throw new Error("LGL rate limit hit — please wait a moment and try again");
  if (!res.ok) {
    const detail = await readErrorBody(res);
    throw new Error(`LGL API error ${res.status}${detail ? `: ${detail}` : ""}`);
  }

  if (res.status === 204 || res.headers.get("content-length") === "0") return {};

  return res.json();
}

async function readErrorBody(res) {
  let raw;
  try {
    raw = await res.text();
  } catch {
    return "";
  }
  if (!raw) return "";
  try {
    const j = JSON.parse(raw);
    if (typeof j === "string") return j;
    if (j.error) return typeof j.error === "string" ? j.error : JSON.stringify(j.error);
    if (j.message) return j.message;
    if (Array.isArray(j.errors) && j.errors.length) {
      return j.errors
        .map((e) => {
          if (typeof e === "string") return e;
          const field = e.field ?? e.attribute;
          const msg = e.message ?? JSON.stringify(e);
          return field ? `${field}: ${msg}` : msg;
        })
        .join("; ");
    }
    return JSON.stringify(j);
  } catch {
    return raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
  }
}

// ─── LGL Integration Queue (human-reviewed writes) ──────────────────────────
// Posts flat key/value pairs to LGL's own custom-integration webhook listener
// (LGL Settings → Integrations). Submissions land in the Integration Queue for
// a human to approve — never written to LGL directly — so these are exempt
// from LGL_READ_ONLY. Field mapping (which key -> which LGL field) is
// configured in LGL's UI, not here; sending an unmapped key is silently
// ignored by LGL rather than erroring.

async function postToIntegrationQueue(fields) {
  const listenerUrl = process.env.LGL_INTEGRATION_LISTENER_URL;
  if (!listenerUrl) {
    throw new Error(
      "LGL_INTEGRATION_LISTENER_URL is not set. Set it to the listener URL from LGL Settings → Integrations for this custom integration."
    );
  }

  const payload = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== "") {
      payload.set(key, String(value));
    }
  }
  if ([...payload.keys()].length === 0) {
    throw new Error("Provide at least one mapped field to submit.");
  }

  const res = await fetch(listenerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: payload.toString(),
  });
  const responseText = await res.text();
  if (!res.ok) {
    throw new Error(`LGL Integration listener returned ${res.status}: ${responseText}`);
  }

  return {
    status: "submitted_for_review",
    note: "Sent to LGL's Integration Queue. This has NOT been written to LGL — a human must approve it in LGL (Settings → Integrations → Integration Queue) first.",
    fields_sent: Object.fromEntries(payload),
    listener_response: responseText,
  };
}

// Flattens up to `count` repeated sub-records (phone/email/address) into the
// numbered key convention LGL's mapping uses: slot 1 is bare (e.g. "phone",
// "phone_type"), slots 2+ get a numeric suffix (e.g. "phone_2", "phone_2_type").
function flattenSlots(items, map, baseKey, { maxSlots = 3, firstSlotBare = true } = {}) {
  const out = {};
  if (!Array.isArray(items)) return out;
  items.slice(0, maxSlots).forEach((item, i) => {
    const slotPrefix = i === 0 && firstSlotBare ? baseKey : `${baseKey}_${i + 1}`;
    for (const [argKey, lglSuffix] of Object.entries(map)) {
      if (item[argKey] !== undefined) {
        out[`${slotPrefix}${lglSuffix}`] = item[argKey];
      }
    }
  });
  return out;
}

// Matching fields shared by every non-constituent submission tool, used by
// LGL's "Match on email address and name" rule to find the right constituent.
const MATCHING_PROPS = {
  first_name: { type: "string", description: "Constituent's first name, for matching" },
  last_name: { type: "string", description: "Constituent's last name, for matching" },
  email: { type: "string", description: "Constituent's email, for matching" },
};

// ─── Date Helpers (UTC) ──────────────────────────────────────────────────────
// Use UTC-anchored math so cutoffs don't shift across local timezones near
// midnight. Returns YYYY-MM-DD.

function utcDateNDaysAgo(days) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
  return d.toISOString().slice(0, 10);
}

function utcDateNMonthsAgo(months) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

// ─── Pagination Helper ───────────────────────────────────────────────────────
// /gifts/search returns at most ~500 records per call. To produce correct
// aggregate reports, walk the dataset in pages. Bounded by `maxPages` so a
// large account doesn't run unbounded; surface `truncated: true` so callers
// know the result may be incomplete.

async function paginateGifts(baseQuery, { pageSize = 200, maxPages = 25 } = {}) {
  const all = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams(baseQuery);
    params.set("limit", String(pageSize));
    params.set("offset", String(offset));
    const data = await lglRequest("GET", `/gifts/search?${params}`);
    const items = data.items ?? data;
    if (!Array.isArray(items) || items.length === 0) return { gifts: all, truncated: false };
    all.push(...items);
    if (items.length < pageSize) return { gifts: all, truncated: false };
    offset += pageSize;
  }
  return { gifts: all, truncated: true };
}

// ─── Formatting Helpers ──────────────────────────────────────────────────────

function toText(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function toError(err) {
  return { content: [{ type: "text", text: err.message }], isError: true };
}

function summaryConstituent(c) {
  return {
    id: c.id,
    name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || c.organization_name || `ID ${c.id}`,
    email: c.email_addresses?.[0]?.address ?? null,
    phone: c.phone_numbers?.[0]?.number ?? null,
    city: c.street_addresses?.[0]?.city ?? null,
    state: c.street_addresses?.[0]?.state ?? null,
  };
}

// LGL's field names for amount/date are inconsistent across endpoints: the
// nested /constituents/{id}/gifts list uses amount/gift_date, while
// /gifts/{id} and /gifts/search use received_amount/received_date. Read both.
function giftAmount(g) {
  return parseFloat(g.amount ?? g.received_amount ?? 0);
}

function giftDate(g) {
  return g.gift_date ?? g.received_date ?? null;
}

function summaryGift(g) {
  return {
    id: g.id,
    constituent_id: g.constituent_id,
    constituent_name: g.constituent_name ?? null,
    date: giftDate(g),
    amount: giftAmount(g),
    campaign: g.campaign_name ?? null,
    fund: g.fund_name ?? null,
    payment_type: g.payment_type_name ?? null,
    note: g.note ?? null,
  };
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

const TOOLS = [
  // ── 1. Constituents & Core Management ──────────────────────────────────────
  {
    name: "search_constituents",
    description: "Search for constituents by name, email, phone, or other keyword",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", default: 20 },
      },
      required: ["query"],
    },
  },
  {
    name: "list_constituents",
    description: "List all constituents with optional pagination",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 50 },
        offset: { type: "number", default: 0 },
      },
    },
  },
  {
    name: "get_constituent",
    description: "Get full details for a single constituent by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Constituent ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "create_constituent",
    description: "Create a new constituent in LGL",
    inputSchema: {
      type: "object",
      properties: {
        first_name: { type: "string" },
        last_name: { type: "string" },
        organization_name: { type: "string" },
        constituent_type: { type: "string", enum: ["individual", "organization"], default: "individual" },
        email: { type: "string", description: "Primary email address" },
        phone: { type: "string", description: "Primary phone number" },
        street: { type: "string" },
        city: { type: "string" },
        state: { type: "string" },
        zip: { type: "string" },
      },
    },
  },
  {
    name: "update_constituent",
    description: "Update an existing constituent's core information",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        first_name: { type: "string" },
        last_name: { type: "string" },
        organization_name: { type: "string" },
        constituent_type: { type: "string", enum: ["individual", "organization"] },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_constituent",
    description: "Delete an existing constituent by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
      },
      required: ["id"],
    },
  },

  // ── 2. Constituent Sub-Resources (Contact Info & Web) ────────────────────────
  // * Street Addresses:
  {
    name: "list_addresses",
    description: "List street addresses for a specific constituent",
    inputSchema: {
      type: "object",
      properties: { constituent_id: { type: "number" } },
      required: ["constituent_id"],
    },
  },
  {
    name: "create_address",
    description: "Add a street address to a constituent",
    inputSchema: {
      type: "object",
      properties: {
        constituent_id: { type: "number" },
        street: { type: "string" },
        city: { type: "string" },
        state: { type: "string" },
        zip: { type: "string", description: "Postal / ZIP Code" },
        country: { type: "string" },
        address_type: { type: "string", description: "e.g. Home, Work, Seasonal" },
        is_primary: { type: "boolean", default: false },
      },
      required: ["constituent_id", "street"],
    },
  },
  {
    name: "update_address",
    description: "Update an existing street address record by Address ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Address ID" },
        street: { type: "string" },
        city: { type: "string" },
        state: { type: "string" },
        zip: { type: "string" },
        country: { type: "string" },
        address_type: { type: "string" },
        is_primary: { type: "boolean" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_address",
    description: "Delete a street address record by Address ID",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Address ID" } },
      required: ["id"],
    },
  },

  // * Phone Numbers:
  {
    name: "list_phone_numbers",
    description: "List phone numbers for a specific constituent",
    inputSchema: {
      type: "object",
      properties: { constituent_id: { type: "number" } },
      required: ["constituent_id"],
    },
  },
  {
    name: "create_phone_number",
    description: "Add a phone number to a constituent",
    inputSchema: {
      type: "object",
      properties: {
        constituent_id: { type: "number" },
        number: { type: "string" },
        phone_type: { type: "string", description: "e.g. Mobile, Home, Work, Fax" },
        is_primary: { type: "boolean", default: false },
      },
      required: ["constituent_id", "number"],
    },
  },
  {
    name: "update_phone_number",
    description: "Update an existing phone number record by Phone ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Phone ID" },
        number: { type: "string" },
        phone_type: { type: "string" },
        is_primary: { type: "boolean" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_phone_number",
    description: "Delete a phone number record by Phone ID",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Phone ID" } },
      required: ["id"],
    },
  },

  // * Email Addresses:
  {
    name: "list_email_addresses",
    description: "List email addresses for a specific constituent",
    inputSchema: {
      type: "object",
      properties: { constituent_id: { type: "number" } },
      required: ["constituent_id"],
    },
  },
  {
    name: "create_email_address",
    description: "Add an email address to a constituent",
    inputSchema: {
      type: "object",
      properties: {
        constituent_id: { type: "number" },
        address: { type: "string" },
        email_type: { type: "string", description: "e.g. Personal, Work" },
        is_primary: { type: "boolean", default: false },
      },
      required: ["constituent_id", "address"],
    },
  },
  {
    name: "update_email_address",
    description: "Update an existing email address record by Email ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Email ID" },
        address: { type: "string" },
        email_type: { type: "string" },
        is_primary: { type: "boolean" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_email_address",
    description: "Delete an email address record by Email ID",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Email ID" } },
      required: ["id"],
    },
  },

  // * Web Addresses:
  {
    name: "list_web_addresses",
    description: "List web addresses (websites/social profiles) for a specific constituent",
    inputSchema: {
      type: "object",
      properties: { constituent_id: { type: "number" } },
      required: ["constituent_id"],
    },
  },
  {
    name: "create_web_address",
    description: "Add a web address to a constituent",
    inputSchema: {
      type: "object",
      properties: {
        constituent_id: { type: "number" },
        url: { type: "string", description: "Website URL" },
        web_address_type: { type: "string", description: "e.g. Personal, Blog, LinkedIn, Twitter" },
      },
      required: ["constituent_id", "url"],
    },
  },
  {
    name: "update_web_address",
    description: "Update an existing web address record by Web Address ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Web Address ID" },
        url: { type: "string" },
        web_address_type: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_web_address",
    description: "Delete a web address record by Web Address ID",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Web Address ID" } },
      required: ["id"],
    },
  },

  // ── 3. Gifts & Fundraising ─────────────────────────────────────────────────
  {
    name: "list_gifts",
    description: "List gifts, either for a specific constituent (nested) or across the account (search). Supports date-range filtering via start_date/end_date (YYYY-MM-DD).",
    inputSchema: {
      type: "object",
      properties: {
        constituent_id: { type: "number", description: "Filter by constituent (calls nested API)" },
        query: { type: "string", description: "Search term across all gifts (if not filtering by constituent)" },
        start_date: { type: "string", description: "Earliest gift_date to include, YYYY-MM-DD (inclusive)" },
        end_date: { type: "string", description: "Latest gift_date to include, YYYY-MM-DD (inclusive)" },
        limit: { type: "number", default: 50 },
      },
    },
  },
  {
    name: "get_gift",
    description: "Get full details for a specific gift record by ID",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Gift ID" } },
      required: ["id"],
    },
  },
  {
    name: "record_gift",
    description: "Record a new gift nested under a specific constituent",
    inputSchema: {
      type: "object",
      properties: {
        constituent_id: { type: "number", description: "Target constituent" },
        amount: { type: "number", description: "Gift amount in USD" },
        gift_date: { type: "string", description: "YYYY-MM-DD" },
        payment_type: { type: "string", description: "e.g. Cash, Check, Credit Card" },
        campaign_name: { type: "string" },
        fund_name: { type: "string" },
        appeal_name: { type: "string" },
        event_name: { type: "string" },
        note: { type: "string" },
      },
      required: ["constituent_id", "amount", "gift_date"],
    },
  },
  {
    name: "update_gift",
    description: "Update an existing gift record by Gift ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Gift ID" },
        amount: { type: "number" },
        gift_date: { type: "string", description: "YYYY-MM-DD" },
        payment_type: { type: "string" },
        campaign_name: { type: "string" },
        fund_name: { type: "string" },
        note: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_gift",
    description: "Delete a specific gift record by Gift ID",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Gift ID" } },
      required: ["id"],
    },
  },

  // Campaigns, Funds, Events:
  {
    name: "list_campaigns",
    description: "List all campaigns",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_campaign",
    description: "Create a new fundraising campaign",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, description: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "get_campaign",
    description: "Get fundraising campaign details by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "update_campaign",
    description: "Update an existing campaign details",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" }, name: { type: "string" }, description: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "delete_campaign",
    description: "Delete a campaign by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "list_funds",
    description: "List all funds",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_fund",
    description: "Create a new fund",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, description: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "get_fund",
    description: "Get fund details by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "update_fund",
    description: "Update fund details",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" }, name: { type: "string" }, description: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "delete_fund",
    description: "Delete a fund by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "list_events",
    description: "List all fundraising events",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_event",
    description: "Create a new event",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, description: { type: "string" }, event_date: { type: "string", description: "YYYY-MM-DD" } },
      required: ["name"],
    },
  },
  {
    name: "get_event",
    description: "Get fundraising event details by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "update_event",
    description: "Update event details",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" }, name: { type: "string" }, event_date: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "delete_event",
    description: "Delete an event by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },

  // ── 4. Appeals & Appeal Requests ───────────────────────────────────────────
  {
    name: "list_appeals",
    description: "List all appeals",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_appeal",
    description: "Create a new appeal",
    inputSchema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" } }, required: ["name"] },
  },
  {
    name: "get_appeal",
    description: "Get appeal details by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "update_appeal",
    description: "Update appeal details",
    inputSchema: { type: "object", properties: { id: { type: "number" }, name: { type: "string" } }, required: ["id"] },
  },
  {
    name: "delete_appeal",
    description: "Delete an appeal by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "list_appeal_requests",
    description: "Fetch appeal requests, either for a specific appeal or for a specific constituent",
    inputSchema: {
      type: "object",
      properties: {
        appeal_id: { type: "number", description: "Filter by Appeal ID" },
        constituent_id: { type: "number", description: "Filter by Constituent ID" },
      },
    },
  },
  {
    name: "create_appeal_request",
    description: "Create a new appeal request, either linked to an appeal or constituent",
    inputSchema: {
      type: "object",
      properties: {
        appeal_id: { type: "number" },
        constituent_id: { type: "number" },
        segment_name: { type: "string" },
        ask_amount: { type: "number" },
      },
      required: ["appeal_id", "constituent_id"],
    },
  },
  {
    name: "get_appeal_request",
    description: "Get details for an appeal request by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "update_appeal_request",
    description: "Update an appeal request details",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" }, ask_amount: { type: "number" }, segment_name: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "delete_appeal_request",
    description: "Delete an appeal request by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },

  // ── 5. Activities, Notes & Contact Reports ─────────────────────────────────
  // * Notes:
  {
    name: "list_notes",
    description: "List notes, optionally filtered by constituent, or fetch all notes",
    inputSchema: {
      type: "object",
      properties: {
        constituent_id: { type: "number", description: "Filter notes by constituent" },
        limit: { type: "number", default: 50 },
      },
    },
  },
  {
    name: "get_note",
    description: "Get full details of a note by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "create_note",
    description: "Log a new note nested under a specific constituent",
    inputSchema: {
      type: "object",
      properties: {
        constituent_id: { type: "number" },
        text: { type: "string", description: "Content of the note" },
        note_date: { type: "string", description: "YYYY-MM-DD" },
        note_type: { type: "string", description: "e.g. Interaction, Email, Alert" },
        subject: { type: "string" },
      },
      required: ["constituent_id", "text"],
    },
  },
  {
    name: "update_note",
    description: "Update an existing note record by Note ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Note ID" },
        text: { type: "string" },
        note_date: { type: "string", description: "YYYY-MM-DD" },
        note_type: { type: "string" },
        subject: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_note",
    description: "Delete a note record by Note ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },

  // * Contact Reports:
  {
    name: "list_contact_reports",
    description: "List contact reports, optionally filtered by constituent, or fetch all",
    inputSchema: {
      type: "object",
      properties: {
        constituent_id: { type: "number", description: "Filter by constituent" },
        limit: { type: "number", default: 50 },
      },
    },
  },
  {
    name: "search_contact_reports",
    description: "Search across contact reports",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_contact_report",
    description: "Get full details of a contact report by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "create_contact_report",
    description: "Create a new contact report nested under a constituent",
    inputSchema: {
      type: "object",
      properties: {
        constituent_id: { type: "number" },
        text: { type: "string", description: "Content of report" },
        contact_type: { type: "string", description: "e.g. Phone, In Person, Email" },
        contact_date: { type: "string", description: "YYYY-MM-DD" },
        subject: { type: "string" },
      },
      required: ["constituent_id", "text"],
    },
  },
  {
    name: "update_contact_report",
    description: "Update an existing contact report by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        text: { type: "string" },
        contact_type: { type: "string" },
        contact_date: { type: "string" },
        subject: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_contact_report",
    description: "Delete a contact report by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },

  // * Volunteer Tracking (Volunteer Times):
  {
    name: "list_volunteer_times",
    description: "List volunteer times, optionally filtered by constituent, or fetch all",
    inputSchema: {
      type: "object",
      properties: {
        constituent_id: { type: "number", description: "Filter by constituent" },
        limit: { type: "number", default: 50 },
      },
    },
  },
  {
    name: "search_volunteer_times",
    description: "Search for volunteer times",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
  },
  {
    name: "get_volunteer_time",
    description: "Get volunteer time record details by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "create_volunteer_time",
    description: "Record volunteer hours nested under a constituent",
    inputSchema: {
      type: "object",
      properties: {
        constituent_id: { type: "number" },
        hours: { type: "number", description: "Hours volunteered" },
        volunteer_date: { type: "string", description: "YYYY-MM-DD" },
        description: { type: "string" },
      },
      required: ["constituent_id", "hours"],
    },
  },
  {
    name: "update_volunteer_time",
    description: "Update an existing volunteer hours record",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        hours: { type: "number" },
        volunteer_date: { type: "string" },
        description: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_volunteer_time",
    description: "Delete a volunteer time record by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },

  // ── 6. Relationships & Class Affiliations ──────────────────────────────────
  // * Relationships:
  {
    name: "list_relationships",
    description: "List constituent relationships for a specific constituent",
    inputSchema: {
      type: "object",
      properties: { constituent_id: { type: "number" } },
      required: ["constituent_id"],
    },
  },
  {
    name: "create_relationship",
    description: "Create a relationship between two constituents (nested under the parent constituent)",
    inputSchema: {
      type: "object",
      properties: {
        constituent_id: { type: "number", description: "The parent constituent" },
        related_constituent_id: { type: "number", description: "The related constituent" },
        relationship_type: { type: "string", description: "e.g. Spouse, Sibling, Child, Parent" },
      },
      required: ["constituent_id", "related_constituent_id", "relationship_type"],
    },
  },
  {
    name: "get_relationship",
    description: "Get details for a constituent relationship by Relationship ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "update_relationship",
    description: "Update relationship type between two constituents by Relationship ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Relationship ID" },
        relationship_type: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_relationship",
    description: "Delete a constituent relationship by Relationship ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },

  // * Class Affiliations:
  {
    name: "list_class_affiliations",
    description: "List class affiliations for a constituent",
    inputSchema: { type: "object", properties: { constituent_id: { type: "number" } }, required: ["constituent_id"] },
  },
  {
    name: "create_class_affiliation",
    description: "Add a class affiliation to a constituent",
    inputSchema: {
      type: "object",
      properties: {
        constituent_id: { type: "number" },
        class_affiliation_type_id: { type: "number" },
        class_year: { type: "number" },
      },
      required: ["constituent_id", "class_affiliation_type_id"],
    },
  },
  {
    name: "get_class_affiliation",
    description: "Get class affiliation details by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "update_class_affiliation",
    description: "Update a class affiliation record",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" }, class_year: { type: "number" } },
      required: ["id"],
    },
  },
  {
    name: "delete_class_affiliation",
    description: "Delete a class affiliation record by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "list_class_affiliation_types",
    description: "List all available class affiliation types",
    inputSchema: { type: "object", properties: {} },
  },

  // ── 7. Groups, Memberships & Invitations ───────────────────────────────────
  // * Groups & Group Memberships:
  {
    name: "list_groups",
    description: "List all constituent groups defined in LGL",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_group",
    description: "Create a new constituent group",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "get_group",
    description: "Get details for a single group by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "update_group",
    description: "Update constituent group details",
    inputSchema: { type: "object", properties: { id: { type: "number" }, name: { type: "string" } }, required: ["id"] },
  },
  {
    name: "delete_group",
    description: "Delete a constituent group",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "list_group_memberships",
    description: "List group memberships for a specific constituent",
    inputSchema: {
      type: "object",
      properties: { constituent_id: { type: "number" } },
      required: ["constituent_id"],
    },
  },
  {
    name: "add_constituent_to_group",
    description: "Add a constituent to a group (creates a group membership)",
    inputSchema: {
      type: "object",
      properties: {
        constituent_id: { type: "number" },
        group_id: { type: "number" },
      },
      required: ["constituent_id", "group_id"],
    },
  },
  {
    name: "get_group_membership",
    description: "Get details for a group membership record by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "update_group_membership",
    description: "Update a group membership record",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" }, group_id: { type: "number" } },
      required: ["id"],
    },
  },
  {
    name: "remove_constituent_from_group",
    description: "Remove a constituent from a group (deletes the group membership record by ID)",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Group Membership ID" } },
      required: ["id"],
    },
  },

  // * Memberships & Levels:
  {
    name: "list_memberships",
    description: "List membership program enrollments for a specific constituent",
    inputSchema: {
      type: "object",
      properties: { constituent_id: { type: "number" } },
      required: ["constituent_id"],
    },
  },
  {
    name: "create_membership",
    description: "Add a membership record to a constituent",
    inputSchema: {
      type: "object",
      properties: {
        constituent_id: { type: "number" },
        membership_level_id: { type: "number" },
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["constituent_id", "membership_level_id"],
    },
  },
  {
    name: "get_membership",
    description: "Get membership record details by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "update_membership",
    description: "Update a membership record by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        membership_level_id: { type: "number" },
        start_date: { type: "string" },
        end_date: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_membership",
    description: "Delete a membership record by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "list_membership_levels",
    description: "List all membership levels defined in LGL",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_membership_level",
    description: "Create a new membership level",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "get_membership_level",
    description: "Get membership level details by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "update_membership_level",
    description: "Update membership level details",
    inputSchema: { type: "object", properties: { id: { type: "number" }, name: { type: "string" } }, required: ["id"] },
  },
  {
    name: "delete_membership_level",
    description: "Delete membership level by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },

  // * Event Invitations:
  {
    name: "list_constituent_invitations",
    description: "List event invitations for a specific constituent",
    inputSchema: { type: "object", properties: { constituent_id: { type: "number" } }, required: ["constituent_id"] },
  },
  {
    name: "create_constituent_invitation",
    description: "Add a constituent to an event (creates an invitation record)",
    inputSchema: {
      type: "object",
      properties: { constituent_id: { type: "number" }, event_id: { type: "number" }, invitation_status: { type: "string", description: "e.g. Invited, RSVP, Attended" } },
      required: ["constituent_id", "event_id"],
    },
  },
  {
    name: "list_event_invitations",
    description: "List invitations for a specific event",
    inputSchema: { type: "object", properties: { event_id: { type: "number" } }, required: ["event_id"] },
  },
  {
    name: "create_event_invitation",
    description: "Add a constituent invitation directly inside an event",
    inputSchema: {
      type: "object",
      properties: { event_id: { type: "number" }, constituent_id: { type: "number" }, invitation_status: { type: "string" } },
      required: ["event_id", "constituent_id"],
    },
  },
  {
    name: "get_invitation",
    description: "Get event invitation details by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "update_invitation",
    description: "Update an event invitation record by ID",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" }, invitation_status: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "delete_invitation",
    description: "Delete an event invitation record by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },

  // ── 8. Categories & Keywords Customization ─────────────────────────────────
  {
    name: "list_categories",
    description: "List all category types defined in LGL",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_category",
    description: "Create a new custom category",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "get_category",
    description: "Get custom category details by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "update_category",
    description: "Update custom category name by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" }, name: { type: "string" } }, required: ["id"] },
  },
  {
    name: "delete_category",
    description: "Delete a custom category by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "list_keywords",
    description: "List keywords nested under a specific category",
    inputSchema: { type: "object", properties: { category_id: { type: "number" } }, required: ["category_id"] },
  },
  {
    name: "create_keyword",
    description: "Create a new keyword nested under a category",
    inputSchema: {
      type: "object",
      properties: { category_id: { type: "number" }, name: { type: "string" } },
      required: ["category_id", "name"],
    },
  },
  {
    name: "get_keyword",
    description: "Get keyword details by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "update_keyword",
    description: "Update a keyword record by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" }, name: { type: "string" } }, required: ["id"] },
  },
  {
    name: "delete_keyword",
    description: "Delete a keyword record by ID",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "list_constituent_categories",
    description: "List categories assigned to a constituent",
    inputSchema: { type: "object", properties: { constituent_id: { type: "number" } }, required: ["constituent_id"] },
  },
  {
    name: "add_keyword_to_constituent",
    description: "Assign a keyword (attribute/tag) to a constituent",
    inputSchema: {
      type: "object",
      properties: { constituent_id: { type: "number" }, keyword_id: { type: "number" } },
      required: ["constituent_id", "keyword_id"],
    },
  },
  {
    name: "remove_keyword_from_constituent",
    description: "Remove keyword assignment from a constituent",
    inputSchema: {
      type: "object",
      properties: { constituent_id: { type: "number" }, id: { type: "number", description: "Keyword assignment record ID" } },
      required: ["constituent_id", "id"],
    },
  },

  // ── 9. Helper Lists, Metadata & System Types ───────────────────────────────
  {
    name: "list_lists",
    description: "List all default lists configured in LGL",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_lists",
    description: "Search lists",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "list_mailing_templates",
    description: "List all mailing templates",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_team_members",
    description: "List LGL team members / account users",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_custom_attributes",
    description: "List custom attributes defined in LGL",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_gift_categories",
    description: "List gift categories",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_gift_types",
    description: "List all gift types",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_payment_types",
    description: "List all payment types",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_relationship_types",
    description: "List all relationship types",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_account_types",
    description: "List types for an account",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_type_values",
    description: "List values for a specific type",
    inputSchema: { type: "object", properties: { type: { type: "string", description: "e.g. constituent_types" } }, required: ["type"] },
  },
  {
    name: "get_metadata",
    description: "Retrieve LGL account metadata",
    inputSchema: { type: "object", properties: {} },
  },

  // ── 10. Reports & Shortcuts ────────────────────────────────────────────────
  {
    name: "recent_donors",
    description: "Get donors who gave within the last N days (defaults to 30)",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Lookback window in days", default: 30 },
      },
    },
  },
  {
    name: "lapsed_donors",
    description: "Find donors who gave previously but not in the last N months",
    inputSchema: {
      type: "object",
      properties: {
        months_lapsed: { type: "number", default: 12 },
      },
    },
  },
  {
    name: "top_donors",
    description: "Get top donors ranked by total giving, optionally within a date range",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 25 },
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date: { type: "string", description: "YYYY-MM-DD" },
      },
    },
  },
  {
    name: "constituents_missing_info",
    description: "Find constituents missing key contact information",
    inputSchema: {
      type: "object",
      properties: {
        missing: {
          type: "array",
          items: { type: "string", enum: ["email", "phone", "address"] },
        },
        limit: { type: "number", default: 50 },
      },
      required: ["missing"],
    },
  },
  {
    name: "get_donor_context",
    description: "One-shot lookup that returns a constituent's profile plus their recent giving history, group memberships, and recent notes. Saves 4-5 round trips compared to calling get_constituent + list_gifts + list_group_memberships + list_notes separately for the common 'tell me about <donor>' workflow. Accepts either constituent_id (preferred) or name (resolved via search; errors with candidates if multiple constituents match).",
    inputSchema: {
      type: "object",
      properties: {
        constituent_id: { type: "number", description: "Direct lookup by ID (preferred if known)" },
        name: { type: "string", description: "Name to resolve via search if ID isn't known. Errors with a candidate list if multiple constituents match." },
        gift_limit: { type: "number", default: 10, description: "Max recent gifts to include" },
        note_limit: { type: "number", default: 5, description: "Max recent notes to include" },
      },
    },
  },

  // ── 11. Generic API Call Tool ──────────────────────────────────────────────
  {
    name: "call_lgl_api",
    description: "Raw passthrough to the LGL REST API for endpoints not covered by a typed tool. PREFER the typed tools whenever they cover your use case — they validate inputs, normalize field names, and return summarized payloads. Reach for this only when no typed tool fits; do not use it as a retry path when a typed tool fails.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PATCH", "DELETE"], description: "HTTP Method" },
        path: { type: "string", description: "Endpoint path (e.g. /constituents/1/memberships or /types/constituent_types)" },
        body: { type: "object", description: "Optional JSON payload body for POST/PATCH" },
      },
      required: ["method", "path"],
    },
  },

  // ── 12. Integration Queue (Human-Reviewed Writes) ────────────────────────
  // All five tools below post to the same LGL custom-integration webhook
  // listener (LGL Settings → Integrations). None write to LGL directly —
  // every submission lands in the Integration Queue for a human to approve,
  // so all five stay available even when LGL_READ_ONLY is set. Matching an
  // existing constituent uses LGL's "match on email address and name" rule
  // (LGL constituent ID as a match key is configured but not currently
  // functioning on this integration — omit record_id).
  {
    name: "submit_constituent_for_review",
    description: "Submit a new or updated constituent to LGL's Integration Queue for human review: identity/name fields, up to 3 phone numbers, up to 3 emails, up to 2 mailing addresses, a website, constituent category fields, and a relationship. This does NOT write to LGL directly.",
    inputSchema: {
      type: "object",
      properties: {
        constituent_type: { type: "string", description: "'Individual' or 'Organization'" },
        prefix: { type: "string" }, first_name: { type: "string" }, middle_name: { type: "string" },
        last_name: { type: "string" }, suffix: { type: "string" }, maiden_name: { type: "string" },
        organization_name: { type: "string", description: "For Organization-type constituents" },
        salutation: { type: "string" }, addressee: { type: "string" },
        alt_salutation: { type: "string" }, alt_addressee: { type: "string" },
        spouse_name: { type: "string" }, spouse_first_name: { type: "string" }, spouse_last_name: { type: "string" },
        spouse_nickname: { type: "string" }, marital_status: { type: "string" },
        honorary_name: { type: "string" }, annual_report_name: { type: "string" },
        company: { type: "string", description: "Employer/Organization" }, job_title: { type: "string" },
        birthday: { type: "string", description: "YYYY-MM-DD; use year 2999 if unknown" },
        assistant_name: { type: "string" }, nicknames: { type: "string" },
        external_id: { type: "string", description: "Your own external constituent ID" },
        deceased: { type: "string", description: "yes/no" }, deceased_date: { type: "string" },
        gives_anonymously: { type: "string", description: "yes/no" },
        phones: {
          type: "array", maxItems: 3,
          description: "Up to 3 phone numbers; first item is the primary",
          items: {
            type: "object",
            properties: {
              number: { type: "string" },
              type: { type: "string", description: "Home, Work, Mobile, Fax, Assistant, Skype, Other" },
              preferred: { type: "string", description: "yes/no" },
              invalid: { type: "string", description: "yes/no" },
            },
          },
        },
        emails: {
          type: "array", maxItems: 3,
          description: "Up to 3 email addresses; first item is the primary",
          items: {
            type: "object",
            properties: {
              address: { type: "string" },
              type: { type: "string", description: "Home, Work, Other" },
              preferred: { type: "string", description: "yes/no" },
              invalid: { type: "string", description: "yes/no" },
            },
          },
        },
        addresses: {
          type: "array", maxItems: 2,
          description: "Up to 2 mailing addresses; first item is the primary",
          items: {
            type: "object",
            properties: {
              line1: { type: "string" }, line2: { type: "string" }, line3: { type: "string" },
              city: { type: "string" }, state: { type: "string" }, zip: { type: "string" },
              country: { type: "string" }, county: { type: "string" },
              type: { type: "string", description: "Home, Work, Other" },
              preferred: { type: "string", description: "yes/no" },
              invalid: { type: "string", description: "yes/no" },
              seasonal_from: { type: "string" }, seasonal_to: { type: "string" },
            },
          },
        },
        website: {
          type: "object",
          properties: { url: { type: "string" }, type: { type: "string" } },
        },
        contact_type: { type: "string" }, capacity: { type: "string" },
        groups: { type: "string", description: "Semicolon or comma separated for multiple" },
        interest_level: { type: "string" }, stewards: { type: "string" }, primary_steward: { type: "string" },
        acknowledgment_preference: { type: "string" },
        communication_tags: { type: "string", description: "Semicolon or comma separated for multiple" },
        relationship_from: { type: "string" }, relationship_to: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "submit_gift_for_review",
    description: "Submit a gift, pledge, or goal to LGL's Integration Queue for human review, including tribute (honor/memorial) details. Provide first_name/last_name/email to match the constituent this belongs to. This does NOT write to LGL directly.",
    inputSchema: {
      type: "object",
      properties: {
        ...MATCHING_PROPS,
        gift_type: { type: "string", description: "Gift, In Kind, Pledge, Other Income, In Honor of, In Memory of, Soft Credit, Matching, Installment" },
        gift_amount: { type: "number" }, gift_date: { type: "string", description: "YYYY-MM-DD" },
        campaign_name: { type: "string" }, fund_name: { type: "string" },
        gift_appeal_name: { type: "string" }, gift_event_name: { type: "string" },
        gift_category: { type: "string" }, team_member: { type: "string" }, gift_note: { type: "string" },
        external_gift_id: { type: "string" },
        deductible_amount: { type: "number" }, deposited_amount: { type: "number" },
        deposit_date: { type: "string" }, payment_type: { type: "string" }, check_number: { type: "string" },
        ack_mailing_template: { type: "string" }, ack_mailing_date: { type: "string" },
        gift_is_anonymous: { type: "string", description: "yes/no" },
        tribute_name: { type: "string", description: "\"Honorary - General\", \"Memorial - General\", or a named tribute" },
        tribute_honoree_name: { type: "string" }, tribute_dedication: { type: "string" },
        tribute_recipient_name: { type: "string" }, tribute_recipient_salutation: { type: "string" },
        tribute_recipient_email: { type: "string" }, tribute_recipient_address: { type: "string" },
        tribute_notification_template: { type: "string" },
        installment_due_date: { type: "string" }, payment_amount: { type: "number" },
        pledge_amount: { type: "number" }, pledge_start_date: { type: "string" },
        payment_interval: { type: "string", description: "W, B, M, Q, S, or Y" },
        write_off_amount: { type: "number" }, write_off_date: { type: "string" },
        auto_generate_installments: { type: "string", description: "yes/no" },
        goal_name: { type: "string" }, ask_amount: { type: "number" }, projected_amount: { type: "number" },
        projected_minimum_amount: { type: "number" }, goal_date: { type: "string" }, goal_status: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "submit_note_for_review",
    description: "Submit a note to LGL's Integration Queue for human review. Provide first_name/last_name/email to match the constituent this belongs to. This does NOT write to LGL directly.",
    inputSchema: {
      type: "object",
      properties: {
        ...MATCHING_PROPS,
        note_type: { type: "string" },
        note_date: { type: "string", description: "YYYY-MM-DD" },
        note_text: { type: "string" },
      },
      required: ["note_text"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_event_registration_for_review",
    description: "Submit an event registration/invitation to LGL's Integration Queue for human review. Provide first_name/last_name/email to match the constituent this belongs to. This does NOT write to LGL directly.",
    inputSchema: {
      type: "object",
      properties: {
        ...MATCHING_PROPS,
        event_name: { type: "string", description: "Required to create or associate with an event" },
        attended: { type: "string", description: "yes/no" },
        inv_notes: { type: "string" },
        rsvp_status: { type: "string", description: "Unknown, Invited, Maybe, Yes, No" },
        inv_attendee_count: { type: "number" }, inv_guest_names: { type: "string" },
        date_attended: { type: "string", description: "For recurring events" },
        event_segment_name: { type: "string" },
        is_guest: { type: "string", description: "yes/no" },
        guest_first_name: { type: "string" }, guest_last_name: { type: "string" },
      },
      required: ["event_name"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_appeal_request_for_review",
    description: "Submit an appeal request/status to LGL's Integration Queue for human review. Provide first_name/last_name/email to match the constituent this belongs to. This does NOT write to LGL directly.",
    inputSchema: {
      type: "object",
      properties: {
        ...MATCHING_PROPS,
        appeal_name: { type: "string", description: "Required to create or associate with an appeal" },
        appeal_segment_name: { type: "string" }, appeal_segment_code: { type: "string" },
        appeal_ask_amount: { type: "number" },
        appeal_status: { type: "string", description: "Open, Called, Considering, Declined, Donated" },
        appeal_team_member: { type: "string" },
      },
      required: ["appeal_name"],
      additionalProperties: false,
    },
  },
];

// ─── Handler Dispatcher ──────────────────────────────────────────────────────

async function handleTool(name, args, authInfo) {
  switch (name) {
    // ── 1. Constituents & Core Management ────────────────────────────────────

    case "search_constituents": {
      const params = new URLSearchParams({ q: args.query, limit: args.limit ?? 20 });
      const data = await lglRequest("GET", `/constituents/search?${params}`);
      return toText((data.items ?? data).map(summaryConstituent));
    }

    case "list_constituents": {
      const params = new URLSearchParams({ limit: args.limit ?? 50, offset: args.offset ?? 0 });
      const data = await lglRequest("GET", `/constituents?${params}`);
      return toText((data.items ?? data).map(summaryConstituent));
    }

    case "get_constituent": {
      return toText(await lglRequest("GET", `/constituents/${args.id}`));
    }

    case "create_constituent": {
      const body = {
        first_name: args.first_name,
        last_name: args.last_name,
        organization_name: args.organization_name,
        constituent_type: args.constituent_type ?? "individual",
      };
      if (args.email) body.email_addresses = [{ address: args.email, is_primary: true }];
      if (args.phone) body.phone_numbers = [{ number: args.phone, is_primary: true }];
      if (args.street || args.city || args.state || args.zip) {
        body.street_addresses = [{
          street: args.street, city: args.city,
          state: args.state, postal_code: args.zip, is_primary: true,
        }];
      }
      return toText(await lglRequest("POST", "/constituents", body));
    }

    case "update_constituent": {
      const { id, ...rest } = args;
      const body = {};
      if (rest.first_name !== undefined) body.first_name = rest.first_name;
      if (rest.last_name !== undefined) body.last_name = rest.last_name;
      if (rest.organization_name !== undefined) body.organization_name = rest.organization_name;
      if (rest.constituent_type !== undefined) body.constituent_type = rest.constituent_type;
      return toText(await lglRequest("PATCH", `/constituents/${id}`, body));
    }

    case "delete_constituent": {
      await lglRequest("DELETE", `/constituents/${args.id}`);
      return toText({ success: true, message: `Constituent ${args.id} deleted successfully.` });
    }

    // ── 2. Constituent Sub-Resources (Contact Info & Web) ────────────────────

    // * Street Addresses:
    case "list_addresses": {
      const data = await lglRequest("GET", `/constituents/${args.constituent_id}/street_addresses`);
      return toText(data.items ?? data);
    }
    case "create_address": {
      const body = {
        street: args.street,
        city: args.city,
        state: args.state,
        postal_code: args.zip,
        country: args.country,
        address_type: args.address_type,
        is_primary: args.is_primary ?? false,
      };
      return toText(await lglRequest("POST", `/constituents/${args.constituent_id}/street_addresses`, body));
    }
    case "update_address": {
      const { id, ...rest } = args;
      const body = {};
      if (rest.street !== undefined) body.street = rest.street;
      if (rest.city !== undefined) body.city = rest.city;
      if (rest.state !== undefined) body.state = rest.state;
      if (rest.zip !== undefined) body.postal_code = rest.zip;
      if (rest.country !== undefined) body.country = rest.country;
      if (rest.address_type !== undefined) body.address_type = rest.address_type;
      if (rest.is_primary !== undefined) body.is_primary = rest.is_primary;
      return toText(await lglRequest("PATCH", `/street_addresses/${id}`, body));
    }
    case "delete_address": {
      await lglRequest("DELETE", `/street_addresses/${args.id}`);
      return toText({ success: true, message: `Street address ${args.id} deleted.` });
    }

    // * Phone Numbers:
    case "list_phone_numbers": {
      const data = await lglRequest("GET", `/constituents/${args.constituent_id}/phone_numbers`);
      return toText(data.items ?? data);
    }
    case "create_phone_number": {
      const body = {
        number: args.number,
        phone_type: args.phone_type,
        is_primary: args.is_primary ?? false,
      };
      return toText(await lglRequest("POST", `/constituents/${args.constituent_id}/phone_numbers`, body));
    }
    case "update_phone_number": {
      const { id, ...rest } = args;
      const body = {};
      if (rest.number !== undefined) body.number = rest.number;
      if (rest.phone_type !== undefined) body.phone_type = rest.phone_type;
      if (rest.is_primary !== undefined) body.is_primary = rest.is_primary;
      return toText(await lglRequest("PATCH", `/phone_numbers/${id}`, body));
    }
    case "delete_phone_number": {
      await lglRequest("DELETE", `/phone_numbers/${args.id}`);
      return toText({ success: true, message: `Phone number ${args.id} deleted.` });
    }

    // * Email Addresses:
    case "list_email_addresses": {
      const data = await lglRequest("GET", `/constituents/${args.constituent_id}/email_addresses`);
      return toText(data.items ?? data);
    }
    case "create_email_address": {
      const body = {
        address: args.address,
        email_type: args.email_type,
        is_primary: args.is_primary ?? false,
      };
      return toText(await lglRequest("POST", `/constituents/${args.constituent_id}/email_addresses`, body));
    }
    case "update_email_address": {
      const { id, ...rest } = args;
      const body = {};
      if (rest.address !== undefined) body.address = rest.address;
      if (rest.email_type !== undefined) body.email_type = rest.email_type;
      if (rest.is_primary !== undefined) body.is_primary = rest.is_primary;
      return toText(await lglRequest("PATCH", `/email_addresses/${id}`, body));
    }
    case "delete_email_address": {
      await lglRequest("DELETE", `/email_addresses/${args.id}`);
      return toText({ success: true, message: `Email address ${args.id} deleted.` });
    }

    // * Web Addresses:
    case "list_web_addresses": {
      const data = await lglRequest("GET", `/constituents/${args.constituent_id}/web_addresses`);
      return toText(data.items ?? data);
    }
    case "create_web_address": {
      const body = {
        url: args.url,
        web_address_type: args.web_address_type,
      };
      return toText(await lglRequest("POST", `/constituents/${args.constituent_id}/web_addresses`, body));
    }
    case "update_web_address": {
      const { id, ...rest } = args;
      const body = {};
      if (rest.url !== undefined) body.url = rest.url;
      if (rest.web_address_type !== undefined) body.web_address_type = rest.web_address_type;
      return toText(await lglRequest("PATCH", `/web_addresses/${id}`, body));
    }
    case "delete_web_address": {
      await lglRequest("DELETE", `/web_addresses/${args.id}`);
      return toText({ success: true, message: `Web address ${args.id} deleted.` });
    }

    // ── 3. Gifts & Fundraising ───────────────────────────────────────────────

    case "list_gifts": {
      // LGL's start_date/end_date query params are not honored server-side by
      // either endpoint below (confirmed: identical results regardless of
      // range) — still sent as a hint in case that changes, but filtering is
      // enforced client-side so results are correct either way.
      const limit = args.limit ?? 50;
      const filterByDate = (items) => {
        if (!args.start_date && !args.end_date) return items;
        return items.filter((g) => {
          const d = giftDate(g);
          if (!d) return false;
          if (args.start_date && d < args.start_date) return false;
          if (args.end_date && d > args.end_date) return false;
          return true;
        });
      };
      if (args.constituent_id) {
        const params = new URLSearchParams({ limit: String(limit) });
        if (args.start_date) params.set("start_date", args.start_date);
        if (args.end_date) params.set("end_date", args.end_date);
        const data = await lglRequest("GET", `/constituents/${args.constituent_id}/gifts?${params}`);
        let items = data.items ?? data;

        // The nested gifts list is an abbreviated representation that omits
        // gift_date/received_date entirely (unlike GET /gifts/{id}), so date
        // is always missing here otherwise. Backfill per-record; capped so a
        // donor with a very large gift history doesn't fan out unbounded.
        if (items.length <= 50 && items.some((g) => giftDate(g) === null)) {
          items = await Promise.all(
            items.map(async (g) => {
              if (giftDate(g) !== null) return g;
              try {
                const full = await lglRequest("GET", `/gifts/${g.id}`);
                return { ...g, received_date: full.received_date };
              } catch {
                return g;
              }
            })
          );
        }

        return toText(filterByDate(items).map(summaryGift));
      } else {
        const params = new URLSearchParams({ limit: String(limit) });
        if (args.query) params.set("q", args.query);
        if (args.start_date) params.set("start_date", args.start_date);
        if (args.end_date) params.set("end_date", args.end_date);
        const data = await lglRequest("GET", `/gifts/search?${params}`);
        return toText(filterByDate(data.items ?? data).map(summaryGift));
      }
    }

    case "get_gift": {
      return toText(await lglRequest("GET", `/gifts/${args.id}`));
    }

    case "record_gift": {
      const body = {
        amount: args.amount,
        gift_date: args.gift_date,
      };
      if (args.payment_type) body.payment_type_name = args.payment_type;
      if (args.campaign_name) body.campaign_name = args.campaign_name;
      if (args.fund_name) body.fund_name = args.fund_name;
      if (args.appeal_name) body.appeal_name = args.appeal_name;
      if (args.event_name) body.event_name = args.event_name;
      if (args.note) body.note = args.note;
      return toText(await lglRequest("POST", `/constituents/${args.constituent_id}/gifts`, body));
    }

    case "update_gift": {
      const { id, ...rest } = args;
      const body = {};
      if (rest.amount !== undefined) body.amount = rest.amount;
      if (rest.gift_date !== undefined) body.gift_date = rest.gift_date;
      if (rest.payment_type !== undefined) body.payment_type_name = rest.payment_type;
      if (rest.campaign_name !== undefined) body.campaign_name = rest.campaign_name;
      if (rest.fund_name !== undefined) body.fund_name = rest.fund_name;
      if (rest.note !== undefined) body.note = rest.note;
      return toText(await lglRequest("PATCH", `/gifts/${id}`, body));
    }

    case "delete_gift": {
      await lglRequest("DELETE", `/gifts/${args.id}`);
      return toText({ success: true, message: `Gift ${args.id} deleted successfully.` });
    }

    // Campaigns, Funds, Events handlers:
    case "list_campaigns": {
      const data = await lglRequest("GET", "/campaigns?limit=200");
      return toText(data.items ?? data);
    }
    case "create_campaign": {
      return toText(await lglRequest("POST", "/campaigns", { name: args.name, description: args.description }));
    }
    case "get_campaign": {
      return toText(await lglRequest("GET", `/campaigns/${args.id}`));
    }
    case "update_campaign": {
      return toText(await lglRequest("PATCH", `/campaigns/${args.id}`, { name: args.name, description: args.description }));
    }
    case "delete_campaign": {
      await lglRequest("DELETE", `/campaigns/${args.id}`);
      return toText({ success: true, message: `Campaign ${args.id} deleted.` });
    }

    case "list_funds": {
      const data = await lglRequest("GET", "/funds?limit=200");
      return toText(data.items ?? data);
    }
    case "create_fund": {
      return toText(await lglRequest("POST", "/funds", { name: args.name, description: args.description }));
    }
    case "get_fund": {
      return toText(await lglRequest("GET", `/funds/${args.id}`));
    }
    case "update_fund": {
      return toText(await lglRequest("PATCH", `/funds/${args.id}`, { name: args.name, description: args.description }));
    }
    case "delete_fund": {
      await lglRequest("DELETE", `/funds/${args.id}`);
      return toText({ success: true, message: `Fund ${args.id} deleted.` });
    }

    case "list_events": {
      const data = await lglRequest("GET", "/events?limit=200");
      return toText(data.items ?? data);
    }
    case "create_event": {
      return toText(await lglRequest("POST", "/events", { name: args.name, description: args.description, event_date: args.event_date }));
    }
    case "get_event": {
      return toText(await lglRequest("GET", `/events/${args.id}`));
    }
    case "update_event": {
      return toText(await lglRequest("PATCH", `/events/${args.id}`, { name: args.name, event_date: args.event_date }));
    }
    case "delete_event": {
      await lglRequest("DELETE", `/events/${args.id}`);
      return toText({ success: true, message: `Event ${args.id} deleted.` });
    }

    // ── 4. Appeals & Appeal Requests ─────────────────────────────────────────

    case "list_appeals": {
      const data = await lglRequest("GET", "/appeals?limit=200");
      return toText(data.items ?? data);
    }
    case "create_appeal": {
      return toText(await lglRequest("POST", "/appeals", { name: args.name, description: args.description }));
    }
    case "get_appeal": {
      return toText(await lglRequest("GET", `/appeals/${args.id}`));
    }
    case "update_appeal": {
      return toText(await lglRequest("PATCH", `/appeals/${args.id}`, { name: args.name }));
    }
    case "delete_appeal": {
      await lglRequest("DELETE", `/appeals/${args.id}`);
      return toText({ success: true, message: `Appeal ${args.id} deleted.` });
    }

    case "list_appeal_requests": {
      if (args.appeal_id) {
        const data = await lglRequest("GET", `/appeals/${args.appeal_id}/appeal_requests`);
        return toText(data.items ?? data);
      } else if (args.constituent_id) {
        const data = await lglRequest("GET", `/constituents/${args.constituent_id}/appeal_requests`);
        return toText(data.items ?? data);
      } else {
        throw new Error("Either appeal_id or constituent_id must be provided to list appeal requests.");
      }
    }
    case "create_appeal_request": {
      const body = { ask_amount: args.ask_amount, segment_name: args.segment_name };
      return toText(await lglRequest("POST", `/appeals/${args.appeal_id}/appeal_requests`, { constituent_id: args.constituent_id, ...body }));
    }
    case "get_appeal_request": {
      return toText(await lglRequest("GET", `/appeal_requests/${args.id}`));
    }
    case "update_appeal_request": {
      const body = {};
      if (args.ask_amount !== undefined) body.ask_amount = args.ask_amount;
      if (args.segment_name !== undefined) body.segment_name = args.segment_name;
      return toText(await lglRequest("PATCH", `/appeal_requests/${args.id}`, body));
    }
    case "delete_appeal_request": {
      await lglRequest("DELETE", `/appeal_requests/${args.id}`);
      return toText({ success: true, message: `Appeal request ${args.id} deleted.` });
    }

    // ── 5. Activities, Notes & Contact Reports ───────────────────────────────

    // * Notes:
    case "list_notes": {
      const params = new URLSearchParams({ limit: (args.limit ?? 50).toString() });
      if (args.constituent_id) {
        const data = await lglRequest("GET", `/constituents/${args.constituent_id}/notes?${params}`);
        return toText(data.items ?? data);
      } else {
        const data = await lglRequest("GET", `/notes?${params}`);
        return toText(data.items ?? data);
      }
    }
    case "get_note": {
      return toText(await lglRequest("GET", `/notes/${args.id}`));
    }
    case "create_note": {
      const body = {
        text: args.text,
        note_date: args.note_date,
        note_type: args.note_type,
        subject: args.subject,
      };
      return toText(await lglRequest("POST", `/constituents/${args.constituent_id}/notes`, body));
    }
    case "update_note": {
      const { id, ...rest } = args;
      const body = {};
      if (rest.text !== undefined) body.text = rest.text;
      if (rest.note_date !== undefined) body.note_date = rest.note_date;
      if (rest.note_type !== undefined) body.note_type = rest.note_type;
      if (rest.subject !== undefined) body.subject = rest.subject;
      return toText(await lglRequest("PATCH", `/notes/${id}`, body));
    }
    case "delete_note": {
      await lglRequest("DELETE", `/notes/${args.id}`);
      return toText({ success: true, message: `Note ${args.id} deleted.` });
    }

    // * Contact Reports:
    case "list_contact_reports": {
      const params = new URLSearchParams({ limit: (args.limit ?? 50).toString() });
      if (args.constituent_id) {
        const data = await lglRequest("GET", `/constituents/${args.constituent_id}/contact_reports?${params}`);
        return toText(data.items ?? data);
      } else {
        const data = await lglRequest("GET", `/contact_reports?${params}`);
        return toText(data.items ?? data);
      }
    }
    case "search_contact_reports": {
      const params = new URLSearchParams({ q: args.query });
      const data = await lglRequest("GET", `/contact_reports/search?${params}`);
      return toText(data.items ?? data);
    }
    case "get_contact_report": {
      return toText(await lglRequest("GET", `/contact_reports/${args.id}`));
    }
    case "create_contact_report": {
      const body = {
        text: args.text,
        contact_type: args.contact_type,
        contact_date: args.contact_date,
        subject: args.subject,
      };
      return toText(await lglRequest("POST", `/constituents/${args.constituent_id}/contact_reports`, body));
    }
    case "update_contact_report": {
      const { id, ...rest } = args;
      const body = {};
      if (rest.text !== undefined) body.text = rest.text;
      if (rest.contact_type !== undefined) body.contact_type = rest.contact_type;
      if (rest.contact_date !== undefined) body.contact_date = rest.contact_date;
      if (rest.subject !== undefined) body.subject = rest.subject;
      return toText(await lglRequest("PATCH", `/contact_reports/${id}`, body));
    }
    case "delete_contact_report": {
      await lglRequest("DELETE", `/contact_reports/${args.id}`);
      return toText({ success: true, message: `Contact report ${args.id} deleted.` });
    }

    // * Volunteer Tracking:
    case "list_volunteer_times": {
      const params = new URLSearchParams({ limit: (args.limit ?? 50).toString() });
      if (args.constituent_id) {
        const data = await lglRequest("GET", `/constituents/${args.constituent_id}/volunteer_times?${params}`);
        return toText(data.items ?? data);
      } else {
        const data = await lglRequest("GET", `/volunteer_times?${params}`);
        return toText(data.items ?? data);
      }
    }
    case "search_volunteer_times": {
      const params = new URLSearchParams({ q: args.query });
      const data = await lglRequest("GET", `/volunteer_times/search?${params}`);
      return toText(data.items ?? data);
    }
    case "get_volunteer_time": {
      return toText(await lglRequest("GET", `/volunteer_times/${args.id}`));
    }
    case "create_volunteer_time": {
      const body = {
        hours: args.hours,
        volunteer_date: args.volunteer_date,
        description: args.description,
      };
      return toText(await lglRequest("POST", `/constituents/${args.constituent_id}/volunteer_times`, body));
    }
    case "update_volunteer_time": {
      const { id, ...rest } = args;
      const body = {};
      if (rest.hours !== undefined) body.hours = rest.hours;
      if (rest.volunteer_date !== undefined) body.volunteer_date = rest.volunteer_date;
      if (rest.description !== undefined) body.description = rest.description;
      return toText(await lglRequest("PATCH", `/volunteer_times/${id}`, body));
    }
    case "delete_volunteer_time": {
      await lglRequest("DELETE", `/volunteer_times/${args.id}`);
      return toText({ success: true, message: `Volunteer time record ${args.id} deleted.` });
    }

    // ── 6. Relationships & Class Affiliations ────────────────────────────────

    // * Relationships:
    case "list_relationships": {
      const data = await lglRequest("GET", `/constituents/${args.constituent_id}/constituent_relationships`);
      return toText(data.items ?? data);
    }
    case "create_relationship": {
      const body = {
        related_constituent_id: args.related_constituent_id,
        relationship_type: args.relationship_type,
      };
      return toText(await lglRequest("POST", `/constituents/${args.constituent_id}/constituent_relationships`, body));
    }
    case "get_relationship": {
      return toText(await lglRequest("GET", `/constituent_relationships/${args.id}`));
    }
    case "update_relationship": {
      const body = {};
      if (args.relationship_type !== undefined) body.relationship_type = args.relationship_type;
      return toText(await lglRequest("PATCH", `/constituent_relationships/${args.id}`, body));
    }
    case "delete_relationship": {
      await lglRequest("DELETE", `/constituent_relationships/${args.id}`);
      return toText({ success: true, message: `Relationship ${args.id} deleted.` });
    }

    // * Class Affiliations:
    case "list_class_affiliations": {
      const data = await lglRequest("GET", `/constituents/${args.constituent_id}/class_affiliations`);
      return toText(data.items ?? data);
    }
    case "create_class_affiliation": {
      const body = { class_affiliation_type_id: args.class_affiliation_type_id, class_year: args.class_year };
      return toText(await lglRequest("POST", `/constituents/${args.constituent_id}/class_affiliations`, body));
    }
    case "get_class_affiliation": {
      return toText(await lglRequest("GET", `/class_affiliations/${args.id}`));
    }
    case "update_class_affiliation": {
      return toText(await lglRequest("PATCH", `/class_affiliations/${args.id}`, { class_year: args.class_year }));
    }
    case "delete_class_affiliation": {
      await lglRequest("DELETE", `/class_affiliations/${args.id}`);
      return toText({ success: true, message: `Class affiliation ${args.id} deleted.` });
    }
    case "list_class_affiliation_types": {
      const data = await lglRequest("GET", "/class_affiliation_types");
      return toText(data.items ?? data);
    }

    // ── 7. Groups, Memberships & Invitations ─────────────────────────────────

    // * Groups & Memberships:
    case "list_groups": {
      const data = await lglRequest("GET", "/groups?limit=200");
      return toText((data.items ?? data).map((g) => ({ id: g.id, name: g.name })));
    }
    case "create_group": {
      return toText(await lglRequest("POST", "/groups", { name: args.name }));
    }
    case "get_group": {
      return toText(await lglRequest("GET", `/groups/${args.id}`));
    }
    case "update_group": {
      return toText(await lglRequest("PATCH", `/groups/${args.id}`, { name: args.name }));
    }
    case "delete_group": {
      await lglRequest("DELETE", `/groups/${args.id}`);
      return toText({ success: true, message: `Group ${args.id} deleted successfully.` });
    }

    case "list_group_memberships": {
      const data = await lglRequest("GET", `/constituents/${args.constituent_id}/group_memberships`);
      return toText(data.items ?? data);
    }
    case "add_constituent_to_group": {
      return toText(await lglRequest(
        "POST",
        `/constituents/${args.constituent_id}/group_memberships`,
        { group_id: args.group_id }
      ));
    }
    case "get_group_membership": {
      return toText(await lglRequest("GET", `/group_memberships/${args.id}`));
    }
    case "update_group_membership": {
      return toText(await lglRequest("PATCH", `/group_memberships/${args.id}`, { group_id: args.group_id }));
    }
    case "remove_constituent_from_group": {
      await lglRequest("DELETE", `/group_memberships/${args.id}`);
      return toText({ success: true, message: `Group membership ${args.id} removed.` });
    }

    // * Memberships & Levels:
    case "list_memberships": {
      const data = await lglRequest("GET", `/constituents/${args.constituent_id}/memberships`);
      return toText(data.items ?? data);
    }
    case "create_membership": {
      const body = {
        membership_level_id: args.membership_level_id,
        start_date: args.start_date,
        end_date: args.end_date,
      };
      return toText(await lglRequest("POST", `/constituents/${args.constituent_id}/memberships`, body));
    }
    case "get_membership": {
      return toText(await lglRequest("GET", `/memberships/${args.id}`));
    }
    case "update_membership": {
      const { id, ...rest } = args;
      const body = {};
      if (rest.membership_level_id !== undefined) body.membership_level_id = rest.membership_level_id;
      if (rest.start_date !== undefined) body.start_date = rest.start_date;
      if (rest.end_date !== undefined) body.end_date = rest.end_date;
      return toText(await lglRequest("PATCH", `/memberships/${id}`, body));
    }
    case "delete_membership": {
      await lglRequest("DELETE", `/memberships/${args.id}`);
      return toText({ success: true, message: `Membership record ${args.id} deleted.` });
    }
    case "list_membership_levels": {
      const data = await lglRequest("GET", "/membership_levels");
      return toText(data.items ?? data);
    }
    case "create_membership_level": {
      return toText(await lglRequest("POST", "/membership_levels", { name: args.name }));
    }
    case "get_membership_level": {
      return toText(await lglRequest("GET", `/membership_levels/${args.id}`));
    }
    case "update_membership_level": {
      return toText(await lglRequest("PATCH", `/membership_levels/${args.id}`, { name: args.name }));
    }
    case "delete_membership_level": {
      await lglRequest("DELETE", `/membership_levels/${args.id}`);
      return toText({ success: true, message: `Membership level ${args.id} deleted.` });
    }

    // * Event Invitations:
    case "list_constituent_invitations": {
      const data = await lglRequest("GET", `/constituents/${args.constituent_id}/invitations`);
      return toText(data.items ?? data);
    }
    case "create_constituent_invitation": {
      return toText(await lglRequest("POST", `/constituents/${args.constituent_id}/invitations`, { event_id: args.event_id, invitation_status: args.invitation_status }));
    }
    case "list_event_invitations": {
      const data = await lglRequest("GET", `/events/${args.event_id}/invitations`);
      return toText(data.items ?? data);
    }
    case "create_event_invitation": {
      return toText(await lglRequest("POST", `/events/${args.event_id}/invitations`, { constituent_id: args.constituent_id, invitation_status: args.invitation_status }));
    }
    case "get_invitation": {
      return toText(await lglRequest("GET", `/invitations/${args.id}`));
    }
    case "update_invitation": {
      return toText(await lglRequest("PATCH", `/invitations/${args.id}`, { invitation_status: args.invitation_status }));
    }
    case "delete_invitation": {
      await lglRequest("DELETE", `/invitations/${args.id}`);
      return toText({ success: true, message: `Event invitation ${args.id} deleted.` });
    }

    // ── 8. Categories & Keywords Customization ───────────────────────────────

    case "list_categories": {
      const data = await lglRequest("GET", "/categories?limit=200");
      return toText(data.items ?? data);
    }
    case "create_category": {
      return toText(await lglRequest("POST", "/categories", { name: args.name }));
    }
    case "get_category": {
      return toText(await lglRequest("GET", `/categories/${args.id}`));
    }
    case "update_category": {
      return toText(await lglRequest("PATCH", `/categories/${args.id}`, { name: args.name }));
    }
    case "delete_category": {
      await lglRequest("DELETE", `/categories/${args.id}`);
      return toText({ success: true, message: `Category ${args.id} deleted.` });
    }

    case "list_keywords": {
      const data = await lglRequest("GET", `/categories/${args.category_id}/keywords`);
      return toText(data.items ?? data);
    }
    case "create_keyword": {
      return toText(await lglRequest("POST", `/categories/${args.category_id}/keywords`, { name: args.name }));
    }
    case "get_keyword": {
      return toText(await lglRequest("GET", `/keywords/${args.id}`));
    }
    case "update_keyword": {
      return toText(await lglRequest("PATCH", `/keywords/${args.id}`, { name: args.name }));
    }
    case "delete_keyword": {
      await lglRequest("DELETE", `/keywords/${args.id}`);
      return toText({ success: true, message: `Keyword ${args.id} deleted.` });
    }

    case "list_constituent_categories": {
      const data = await lglRequest("GET", `/constituents/${args.constituent_id}/categories`);
      return toText(data.items ?? data);
    }
    case "add_keyword_to_constituent": {
      return toText(await lglRequest("POST", `/constituents/${args.constituent_id}/keywords`, { keyword_id: args.keyword_id }));
    }
    case "remove_keyword_from_constituent": {
      await lglRequest("DELETE", `/constituents/${args.constituent_id}/keywords/${args.id}`);
      return toText({ success: true, message: `Keyword assignment ${args.id} removed.` });
    }

    // ── 9. Helper Lists, Metadata & System Types ─────────────────────────────

    case "list_lists": {
      const data = await lglRequest("GET", "/lists");
      return toText(data.items ?? data);
    }
    case "search_lists": {
      const params = new URLSearchParams({ q: args.query });
      const data = await lglRequest("GET", `/lists/search?${params}`);
      return toText(data.items ?? data);
    }
    case "list_mailing_templates": {
      const data = await lglRequest("GET", "/mailing_templates");
      return toText(data.items ?? data);
    }
    case "list_team_members": {
      const data = await lglRequest("GET", "/team_members");
      return toText(data.items ?? data);
    }
    case "list_custom_attributes": {
      const data = await lglRequest("GET", "/attributes");
      return toText(data.items ?? data);
    }
    case "list_gift_categories": {
      const data = await lglRequest("GET", "/gift_categories");
      return toText(data.items ?? data);
    }
    case "list_gift_types": {
      const data = await lglRequest("GET", "/gift_types");
      return toText(data.items ?? data);
    }
    case "list_payment_types": {
      const data = await lglRequest("GET", "/payment_types");
      return toText(data.items ?? data);
    }
    case "list_relationship_types": {
      const data = await lglRequest("GET", "/relationship_types");
      return toText(data.items ?? data);
    }
    case "list_account_types": {
      const data = await lglRequest("GET", "/types");
      return toText(data.items ?? data);
    }
    case "list_type_values": {
      const data = await lglRequest("GET", `/types/${args.type}`);
      return toText(data.items ?? data);
    }
    case "get_metadata": {
      return toText(await lglRequest("GET", "/metadata"));
    }

    // ── 10. Reports & Shortcuts ──────────────────────────────────────────────

    case "recent_donors": {
      // start_date is still sent as a hint, but LGL doesn't honor it
      // server-side, so the cutoff is enforced client-side below.
      const days = args.days ?? 30;
      const start_date = utcDateNDaysAgo(days);
      const { gifts, truncated } = await paginateGifts({ start_date });

      const byConstituent = {};
      for (const g of gifts) {
        const d = giftDate(g);
        if (!d || d < start_date) continue;
        const cid = g.constituent_id;
        if (!byConstituent[cid]) {
          byConstituent[cid] = {
            constituent_id: cid,
            name: g.constituent_name ?? `ID ${cid}`,
            last_gift_date: d,
            total_given: 0,
            gift_count: 0,
          };
        }
        const rec = byConstituent[cid];
        rec.total_given += giftAmount(g);
        rec.gift_count += 1;
        if (d > rec.last_gift_date) rec.last_gift_date = d;
      }

      const donors = Object.values(byConstituent).sort((a, b) =>
        b.last_gift_date.localeCompare(a.last_gift_date)
      );

      const result = { since: start_date, count: donors.length, donors };
      if (truncated) {
        result.truncated = true;
        result.notice = "Hit pagination ceiling — totals and counts may be incomplete for high-volume accounts.";
      }
      return toText(result);
    }

    case "lapsed_donors": {
      // A donor is "lapsed" if their most recent gift is older than the
      // cutoff. LGL's start_date/end_date query params aren't honored
      // server-side (confirmed: identical results regardless of range), so
      // this used to split into two server-filtered queries that both
      // silently returned the full unfiltered dataset — active/pre-cutoff
      // sets ended up identical and nothing was ever classified as lapsed.
      // Fixed by pulling the full gift history once and classifying by each
      // constituent's actual last gift date, computed client-side.
      const months = args.months_lapsed ?? 12;
      const cutoffStr = utcDateNMonthsAgo(months);

      const { gifts, truncated } = await paginateGifts({});
      const latest = {};
      const totals = {};
      for (const g of gifts) {
        const d = giftDate(g);
        if (!d) continue;
        const cid = g.constituent_id;
        if (!latest[cid] || d > latest[cid].date) {
          latest[cid] = { date: d, name: g.constituent_name ?? `ID ${cid}` };
        }
        totals[cid] = (totals[cid] ?? 0) + giftAmount(g);
      }

      const lapsed = Object.entries(latest)
        .filter(([, v]) => v.date < cutoffStr)
        .map(([cid, v]) => ({
          constituent_id: parseInt(cid),
          name: v.name,
          last_gift_date: v.date,
          lifetime_total: totals[cid] ?? 0,
        }))
        .sort((a, b) => a.last_gift_date.localeCompare(b.last_gift_date));

      const result = { cutoff: cutoffStr, months_lapsed: months, count: lapsed.length, lapsed_donors: lapsed };
      if (truncated) {
        result.truncated = true;
        result.notice = "Hit pagination ceiling — results may be incomplete for high-volume accounts.";
      }
      return toText(result);
    }

    case "top_donors": {
      // start_date/end_date are sent as hints but not honored server-side by
      // LGL, so the range is enforced client-side against each gift's
      // resolved date once fetched.
      const limit = args.limit ?? 25;
      const baseQuery = {};
      if (args.start_date) baseQuery.start_date = args.start_date;
      if (args.end_date) baseQuery.end_date = args.end_date;

      const { gifts, truncated } = await paginateGifts(baseQuery);

      const agg = {};
      for (const g of gifts) {
        const d = giftDate(g);
        if (args.start_date && (!d || d < args.start_date)) continue;
        if (args.end_date && (!d || d > args.end_date)) continue;
        const cid = g.constituent_id;
        if (!agg[cid]) {
          agg[cid] = { constituent_id: cid, name: g.constituent_name ?? `ID ${cid}`, total_given: 0, gift_count: 0 };
        }
        agg[cid].total_given += giftAmount(g);
        agg[cid].gift_count += 1;
      }

      const ranked = Object.values(agg)
        .sort((a, b) => b.total_given - a.total_given)
        .slice(0, limit)
        .map((rec, i) => ({ rank: i + 1, ...rec }));

      const result = { count: ranked.length, top_donors: ranked };
      if (args.start_date) result.start_date = args.start_date;
      if (args.end_date) result.end_date = args.end_date;
      if (truncated) {
        result.truncated = true;
        result.notice = "Hit pagination ceiling — rankings may be incomplete for high-volume accounts.";
      }
      return toText(result);
    }

    case "constituents_missing_info": {
      const limit = args.limit ?? 50;
      const data = await lglRequest("GET", "/constituents?limit=500");
      const all = data.items ?? data;
      const missing_fields = args.missing;
      const results = [];

      for (const c of all) {
        const absent = [];
        if (missing_fields.includes("email") && !(c.email_addresses?.length)) absent.push("email");
        if (missing_fields.includes("phone") && !(c.phone_numbers?.length)) absent.push("phone");
        if (missing_fields.includes("address") && !(c.street_addresses?.length)) absent.push("address");
        if (absent.length > 0) results.push({ ...summaryConstituent(c), missing_fields: absent });
        if (results.length >= limit) break;
      }

      return toText(results);
    }

    case "get_donor_context": {
      // Resolve to a numeric constituent_id first. If only a name is given,
      // search and require an unambiguous match — return the candidate list
      // on ambiguity so the model can ask the user or retry with an ID.
      let id = args.constituent_id;
      if (!id) {
        if (!args.name) {
          throw new Error("Provide either constituent_id or name.");
        }
        const params = new URLSearchParams({ q: args.name, limit: "10" });
        const search = await lglRequest("GET", `/constituents/search?${params}`);
        const matches = (search.items ?? search) || [];
        if (!Array.isArray(matches) || matches.length === 0) {
          throw new Error(`No constituent found matching "${args.name}". Try a broader query with search_constituents.`);
        }
        if (matches.length > 1) {
          const candidates = matches.slice(0, 10).map(summaryConstituent);
          throw new Error(
            `Multiple constituents match "${args.name}". Re-call with a specific constituent_id. Candidates: ${JSON.stringify(candidates)}`
          );
        }
        id = matches[0].id;
      }

      const giftLimit = args.gift_limit ?? 10;
      const noteLimit = args.note_limit ?? 5;

      // Fan out the dependent reads. Group memberships and notes are optional
      // (not every account exposes them on every constituent), so swallow
      // 404s on those rather than failing the whole context call.
      const [constituent, giftsData, groupsData, notesData] = await Promise.all([
        lglRequest("GET", `/constituents/${id}`),
        lglRequest("GET", `/constituents/${id}/gifts?limit=${giftLimit}`).catch((e) => ({ _error: e.message })),
        lglRequest("GET", `/constituents/${id}/group_memberships`).catch((e) => ({ _error: e.message })),
        lglRequest("GET", `/constituents/${id}/notes?limit=${noteLimit}`).catch((e) => ({ _error: e.message })),
      ]);

      return toText({
        constituent: summaryConstituent(constituent),
        full_record: constituent,
        recent_gifts: giftsData._error ? { error: giftsData._error } : (giftsData.items ?? giftsData).map(summaryGift),
        group_memberships: groupsData._error ? { error: groupsData._error } : (groupsData.items ?? groupsData),
        recent_notes: notesData._error ? { error: notesData._error } : (notesData.items ?? notesData),
      });
    }

    // ── 11. Generic API Call Tool ────────────────────────────────────────────

    case "call_lgl_api": {
      const { method, path, body } = args;
      return toText(await lglRequest(method, path, body));
    }

    // ── 12. Integration Queue (Human-Reviewed Writes) ────────────────────────

    case "submit_constituent_for_review": {
      const {
        phones, emails, addresses, website,
        ...scalars
      } = args;

      const fields = {
        ...scalars,
        ...flattenSlots(phones, { number: "", type: "_type", preferred: "_preferred", invalid: "_invalid" }, "phone", { maxSlots: 3, firstSlotBare: true }),
        ...flattenSlots(emails, { address: "", type: "_type", preferred: "_preferred", invalid: "_invalid" }, "email", { maxSlots: 3, firstSlotBare: true }),
        ...flattenSlots(addresses, {
          line1: "_line1", line2: "_line2", line3: "_line3", city: "_city", state: "_state",
          zip: "_zip", country: "_country", county: "_county", type: "_type",
          preferred: "_preferred", invalid: "_invalid", seasonal_from: "_seasonal_from", seasonal_to: "_seasonal_to",
        }, "address", { maxSlots: 2, firstSlotBare: false }),
      };
      if (website?.url !== undefined) fields.website_1 = website.url;
      if (website?.type !== undefined) fields.website_1_type = website.type;

      return toText(await postToIntegrationQueue(fields));
    }

    case "submit_gift_for_review": {
      return toText(await postToIntegrationQueue(args));
    }

    case "submit_note_for_review": {
      return toText(await postToIntegrationQueue(args));
    }

    case "submit_event_registration_for_review": {
      return toText(await postToIntegrationQueue(args));
    }

    case "submit_appeal_request_for_review": {
      return toText(await postToIntegrationQueue(args));
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Tool Annotations & Read-Only Mode ──────────────────────────────────────
// Classify every tool so MCP clients (and this server's own write-guard) can
// reason about which calls modify data. Annotations follow the 2025-06-18 MCP
// spec: readOnlyHint, destructiveHint, idempotentHint, openWorldHint.
//
// Set LGL_READ_ONLY=true in the environment to refuse all mutations. Useful
// when pointing the server at a live donor database from an exploratory chat
// session. Read-only mode also hides mutation tools from tools/list so the
// model doesn't try to call them.

function classifyTool(name) {
  if (name === "call_lgl_api") {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  }
  const INTEGRATION_QUEUE_TOOLS = [
    "submit_constituent_for_review", "submit_gift_for_review", "submit_note_for_review",
    "submit_event_registration_for_review", "submit_appeal_request_for_review",
  ];
  if (INTEGRATION_QUEUE_TOOLS.includes(name)) {
    // Deliberately exempt from LGL_READ_ONLY: none of these write to LGL
    // directly. They only POST to LGL's own Integration Queue listener, where
    // a human must approve the record before it's applied — so they're safe
    // to leave available even in read-only deployments.
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  }
  if (name.startsWith("delete_") || name.startsWith("remove_")) {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
  }
  if (name.startsWith("update_")) {
    return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  }
  if (name.startsWith("create_") || name.startsWith("record_") || name.startsWith("add_")) {
    return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  }
  return { readOnlyHint: true, openWorldHint: true };
}

for (const tool of TOOLS) {
  tool.annotations = classifyTool(tool.name);
}

const READ_ONLY_MODE = process.env.LGL_READ_ONLY === "true";

function assertWriteAllowed(name) {
  if (!READ_ONLY_MODE) return;
  if (TOOLS.find((t) => t.name === name)?.annotations?.readOnlyHint) return;
  throw new Error(
    `LGL_READ_ONLY=true is set: tool "${name}" is disabled because it can modify data. ` +
    `Unset LGL_READ_ONLY (or set it to false) to allow writes.`
  );
}

// ─── Server Setup ────────────────────────────────────────────────────────────

const server = new Server(
  { name: "lgl-mcp", version: "1.4.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = READ_ONLY_MODE ? TOOLS.filter((t) => t.annotations?.readOnlyHint) : TOOLS;
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  try {
    assertWriteAllowed(req.params.name);
    return await handleTool(req.params.name, req.params.arguments ?? {}, extra.authInfo);
  } catch (err) {
    return toError(err);
  }
});

// Check if running in HTTP/SSE transport mode
const args = process.argv.slice(2);
const isHttpMode = args.includes("--http") || args.includes("-http") || args.includes("--sse") || args.includes("-sse");

if (isHttpMode) {
  const http = await import("node:http");
  const { parse } = await import("node:url");
  const crypto = await import("node:crypto");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

  // Get port from CLI args (e.g., --port 3000) or env variable, default to 3000
  let port = 3000;
  if (process.env.PORT) {
    port = parseInt(process.env.PORT, 10);
  }
  const portIndex = args.indexOf("--port");
  if (portIndex !== -1 && portIndex + 1 < args.length) {
    port = parseInt(args[portIndex + 1], 10);
  }

  // Stateful Streamable HTTP Transport
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID()
  });

  await server.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    const parsedUrl = parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === "/mcp") {
      // ─── Authentication Middleware ──────────────────────────────────────────
      const authHeader = req.headers["authorization"];
      let token = "";
      if (authHeader && authHeader.startsWith("Bearer ")) {
        token = authHeader.substring(7);
      }

      const expectedToken = process.env.LGL_MCP_TOKEN;
      if (expectedToken) {
        if (token !== expectedToken) {
          res.writeHead(401, { "Content-Type": "text/plain" });
          res.end("Unauthorized: Invalid or missing LGL_MCP_TOKEN Bearer token.");
          return;
        }
      }

      // Attach auth info to request
      req.auth = {
        token,
        scopes: ["all"],
        clientId: "mcp-client"
      };

      // ─── Streamable HTTP Request Handler ────────────────────────────────────
      if (req.method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", async () => {
          try {
            const parsed = body ? JSON.parse(body) : undefined;
            await transport.handleRequest(req, res, parsed);
          } catch (err) {
            console.error("Error parsing JSON body or handling request:", err);
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end(`Bad Request: ${err.message}`);
          }
        });
      } else {
        // GET requests (for establishing the SSE event-stream)
        await transport.handleRequest(req, res);
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  httpServer.listen(port, () => {
    console.error(`LGL MCP server running over Streamable HTTP on http://localhost:${port}/mcp`);
    if (process.env.LGL_MCP_TOKEN) {
      console.error("Secure Bearer Token Authentication is ENABLED.");
    } else {
      console.error("WARNING: LGL_MCP_TOKEN is not set. Running WITHOUT authentication.");
    }
  });

} else {
  // Stdio Transport (Default)
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `LGL MCP server running successfully in stdio mode${READ_ONLY_MODE ? " (read-only mode)" : ""}`
  );
}

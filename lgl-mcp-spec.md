# Little Green Light MCP Server — Claude Code Spec

## Overview

Build a local MCP (Model Context Protocol) server in Node.js that connects Claude to the Little Green Light (LGL) nonprofit CRM API. The server exposes LGL data and actions as MCP tools so the user can interact with their constituents, gifts, and donor data in plain English from Claude.ai.

---

## Deliverables

- `index.js` — single-file MCP server (all logic here)
- `.env.example` — template with required environment variables
- `package.json` — dependencies and start script

Do NOT create a `.env` file with real values. The user will create that from `.env.example`.

---

## Environment Variables

```
LGL_API_KEY=your_lgl_api_key_here
PORT=3000
```

---

## Tech Stack

- **Runtime:** Node.js (v18+)
- **MCP SDK:** `@modelcontextprotocol/sdk` (latest)
- **HTTP client:** `node-fetch` or native `fetch` (Node 18+)
- **Transport:** `StdioServerTransport` (standard MCP local transport)
- **No frameworks** — keep dependencies minimal

---

## LGL API Details

- **Base URL:** `https://api.littlegreenlight.com/api/v1`
- **Auth:** HTTP header — `Authorization: Bearer ${LGL_API_KEY}`
- **Format:** JSON request/response
- **Rate limit:** 300 requests per 5-minute window

Key endpoint patterns:
```
GET    /constituents                  # list/search constituents
GET    /constituents/:id              # get single constituent
POST   /constituents                  # create constituent
PATCH  /constituents/:id              # update constituent
GET    /constituents/:id/gifts        # gifts for a constituent
GET    /gifts                         # list/search all gifts
POST   /constituents/:id/gifts        # record a gift
PATCH  /gifts/:id                     # update a gift
```

All list endpoints support `?limit=` and `?offset=` for pagination. Constituent search supports `?search=` (matches name, email, etc).

---

## MCP Tools to Implement

### Constituents

**`search_constituents`**
- Description: "Search for constituents by name, email, or other keyword"
- Input: `{ query: string, limit?: number (default 20) }`
- Calls: `GET /constituents?search={query}&limit={limit}`
- Returns: array of constituent summaries (id, name, email, phone, city, state)

**`get_constituent`**
- Description: "Get full details for a single constituent by ID"
- Input: `{ id: number }`
- Calls: `GET /constituents/{id}`
- Returns: full constituent record

**`create_constituent`**
- Description: "Create a new constituent in LGL"
- Input: `{ first_name: string, last_name: string, email?: string, phone?: string, street?: string, city?: string, state?: string, zip?: string }`
- Calls: `POST /constituents`
- Returns: created constituent record with new ID

**`update_constituent`**
- Description: "Update an existing constituent's information"
- Input: `{ id: number, first_name?: string, last_name?: string, email?: string, phone?: string, street?: string, city?: string, state?: string, zip?: string }`
- Calls: `PATCH /constituents/{id}`
- Returns: updated constituent record

---

### Gifts

**`get_constituent_gifts`**
- Description: "Get all gifts for a specific constituent"
- Input: `{ constituent_id: number, limit?: number (default 50) }`
- Calls: `GET /constituents/{constituent_id}/gifts?limit={limit}`
- Returns: array of gifts (id, date, amount, campaign, fund, payment_type, note)

**`search_gifts`**
- Description: "Search gifts across all constituents with optional filters"
- Input: `{ constituent_id?: number, min_amount?: number, max_amount?: number, start_date?: string (YYYY-MM-DD), end_date?: string (YYYY-MM-DD), limit?: number (default 50) }`
- Calls: `GET /gifts` with appropriate query params
- Returns: array of gift records with constituent info

**`record_gift`**
- Description: "Record a new gift for a constituent"
- Input: `{ constituent_id: number, amount: number, gift_date: string (YYYY-MM-DD), payment_type?: string, campaign_name?: string, fund_name?: string, note?: string }`
- Calls: `POST /constituents/{constituent_id}/gifts`
- Returns: created gift record

**`update_gift`**
- Description: "Update an existing gift record"
- Input: `{ gift_id: number, amount?: number, gift_date?: string, payment_type?: string, note?: string }`
- Calls: `PATCH /gifts/{gift_id}`
- Returns: updated gift record

---

### Shortcuts (pre-built report tools)

**`recent_donors`**
- Description: "Get donors who gave within the last N days (30, 60, or 90)"
- Input: `{ days: 30 | 60 | 90 }`
- Implementation: Call `GET /gifts?start_date={computed_date}`, aggregate by constituent, return sorted list with constituent name, last gift date, and total given in period
- Returns: array of `{ constituent_id, name, email, last_gift_date, total_given, gift_count }`

**`lapsed_donors`**
- Description: "Find donors who gave previously but not in the last 12 months"
- Input: `{ months_lapsed?: number (default 12) }`
- Implementation: Fetch gifts, find constituents whose most recent gift is older than the lapsed threshold
- Returns: array of `{ constituent_id, name, email, last_gift_date, lifetime_total }` sorted by last_gift_date ascending (longest lapsed first)

**`top_donors`**
- Description: "Get top donors ranked by total giving, optionally within a date range"
- Input: `{ limit?: number (default 25), start_date?: string, end_date?: string }`
- Implementation: Fetch gifts (filtered by date if provided), aggregate by constituent_id, sort descending by total
- Returns: ranked array of `{ rank, constituent_id, name, email, total_given, gift_count }`

**`constituents_missing_info`**
- Description: "Find constituents missing key contact information"
- Input: `{ missing: ('email' | 'phone' | 'address')[], limit?: number (default 50) }`
- Implementation: Fetch constituents, filter client-side for those missing the specified fields
- Returns: array of constituent records highlighting which fields are missing

---

## Error Handling

- Wrap all LGL API calls in try/catch
- On 401: return clear message "LGL API key is invalid or missing — check your .env file"
- On 403: return "Access denied — check API key permissions"
- On 404: return "Record not found (ID: {id})"
- On 429: return "LGL rate limit hit — please wait a moment and try again"
- On network error: return "Could not reach LGL API — check your internet connection"
- Always return meaningful error text (never raw stack traces) to Claude

---

## MCP Server Setup

Use `StdioServerTransport` — this is the standard for local MCP servers:

```js
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server({ name: "lgl-mcp", version: "1.0.0" }, {
  capabilities: { tools: {} }
});

// register tools with server.setRequestHandler(ListToolsRequestSchema, ...)
// handle calls with server.setRequestHandler(CallToolRequestSchema, ...)

const transport = new StdioServerTransport();
await server.connect(transport);
```

---

## Claude Desktop Config (include in README section)

After building, the user adds this to their Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "little-green-light": {
      "command": "node",
      "args": ["/absolute/path/to/index.js"],
      "env": {
        "LGL_API_KEY": "their_api_key_here"
      }
    }
  }
}
```

Config file locations:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

---

## package.json

```json
{
  "name": "lgl-mcp-server",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest"
  }
}
```

---

## Code Style & Quality Notes

- Use ES modules (`import`/`export`), not CommonJS
- Use `async/await` throughout — no callback style
- Keep all LGL API calls in a single helper function `lglRequest(method, path, body?)` that handles auth headers and base URL
- Tool input schemas must use JSON Schema format (as required by MCP SDK)
- Log startup confirmation to stderr (not stdout, which is reserved for MCP transport): `console.error("LGL MCP server running")`
- Do not log API keys anywhere

---

## Suggested Prompt to Test After Setup

Once running, the user should be able to ask Claude things like:

- *"Search for constituents named Johnson"*
- *"Show me top 10 donors this year"*
- *"Who hasn't donated in over a year?"*
- *"Record a $500 gift from constituent 12345 today"*
- *"Which constituents are missing an email address?"*
- *"Show me all gifts from the last 30 days"*

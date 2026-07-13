# Little Green Light (LGL) MCP Server

A direct, secure, and high-fidelity Model Context Protocol (MCP) Server for the Little Green Light CRM database. This server allows AI coding assistants and chat applications (like Claude Desktop, LibreChat, or Open WebUI) to securely interact with your donor database to search constituents, log gifts, categorize taxonomic groups, and generate reports locally without any third-party middleware (like Zapier).

---

## Features

- **Constituents & Core Management:** Search, retrieve, create, update, and delete constituent records.
- **Fundraising & Gifts:** Record new gifts, list transactions (with date-range filters), search payments, and view campaigns, funds, appeals, and events.
- **Contact Sub-Resources:** Fully manage street addresses, phone numbers, email addresses, and web addresses for constituents.
- **Activities & Notes:** Log notes, write contact reports, track volunteer hours, and schedule reminders.
- **Groups & Memberships:** Organize constituents into customizable groups and membership levels.
- **One-Shot Donor Lookup:** `get_donor_context` returns profile + recent gifts + group memberships + recent notes in a single call (resolves by name or ID).
- **Read-Only Safety:** `LGL_READ_ONLY=true` refuses every mutation and hides write tools from `tools/list`. All tools publish MCP destructive/idempotent annotations.
- **Access Audit Trail:** `get_constituent` and `get_donor_context` automatically write an `[AI Access Log]` note directly to the constituent's record noting when it was viewed — this cannot be disabled and works even under `LGL_READ_ONLY`, since the point is to know what was looked at, especially during cautious/exploratory sessions. See [Access Audit Logging](#access-audit-logging) below.
- **Human-Reviewed Writes:** Five `submit_*_for_review` tools post to LGL's own Integration Queue webhook instead of the API, so a person approves every write in LGL before it takes effect — stays available even in read-only mode. See [Human-Reviewed Writes](#human-reviewed-writes-integration-queue) below.
- **Zero-Middleware Architecture:** Data transits directly between the local AI client and the LGL API, reducing security risks and third-party fees.

---

## Installation & Setup

### 1. Prerequisites
- **Node.js** (v18 or higher recommended)
- A **Little Green Light API Key** (Generate one in your LGL account under *Settings > Integration > API Keys*)

### 2. Install Dependencies
Clone this repository to your local machine, open a terminal in the folder, and run:
```bash
npm install
```

### 3. Configure Environment Variables
Copy the `.env.example` template to create your local `.env` configuration file:
```bash
cp .env.example .env
```
Open `.env` in a text editor and replace the placeholder with your actual LGL API key and configuration:
```env
LGL_API_KEY=your_lgl_api_key_here
PORT=3000

# Optional: Secure your Streamable HTTP endpoint with Bearer Token Authentication
LGL_MCP_TOKEN=your_secure_bearer_token_here

# Optional: enables the submit_*_for_review tools — see "Human-Reviewed Writes" below
LGL_INTEGRATION_LISTENER_URL=https://your-account.littlegreenlight.com/integrations/your-integration-id/listener
```

#### Optional: Read-Only Mode
Set `LGL_READ_ONLY=true` to refuse every `create_*`, `update_*`, `delete_*`, `record_*`, and `add_*` tool call. Mutation tools are also hidden from `tools/list` so the AI assistant doesn't try to call them. Recommended whenever you point the server at a live donor database from an exploratory chat session.
```env
LGL_READ_ONLY=true
```

All tools also publish MCP `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so clients can warn before destructive calls without depending on the server-side guard.

---

## Access Audit Logging

Whenever `get_constituent` or `get_donor_context` is called, the server writes a note directly to that constituent's record in LGL — e.g. `[AI Access Log] Record accessed via LGL MCP Server (get_constituent) on 2026-07-13 17:24 UTC.` This is unconditional: it isn't a config option, and it fires even when `LGL_READ_ONLY=true`, since an audit trail of what was viewed is most useful precisely during a cautious, read-only session, not something that should go quiet then.

A few things worth knowing:
- **Scope is single-record detail views only.** Bulk `list_*`/`search_*` calls do *not* log — noting every row of a 50-record list would flood constituents' note history with little audit value. Only tools that open one specific donor's file do.
- **The note writes directly via the API**, not through the Integration Queue — an audit trail that needed human approval to appear defeats the purpose.
- **Best-effort:** if writing the note fails for any reason, the read that triggered it still succeeds; the failure is logged to stderr, not surfaced as a tool error.
- **Note type:** LGL's write API needs an existing `note_type_id` (a number), not a type name — passing a name is silently ignored by LGL rather than applied. The server resolves this at runtime (preferring a type literally named "General", falling back to whatever type exists first) rather than hardcoding an ID, since type IDs are account-specific. This same fix applies to `create_note`/`update_note`, which previously accepted a `note_type` string that never actually applied — invalid type names now raise a clear error instead of silently creating an untyped note.

---

## Human-Reviewed Writes (Integration Queue)

Separate from the direct LGL API, LGL also has a **custom integration webhook** feature (LGL Settings → Integrations → Custom Integrations) that accepts flat key/value submissions and drops them into an **Integration Queue** for a human to approve before anything is actually written to a constituent's record. This server exposes that path as five tools, distinct from the `create_*`/`update_*` API tools:

| Tool | Covers |
|---|---|
| `submit_constituent_for_review` | Identity/name fields, up to 3 phone numbers, up to 3 emails, up to 2 mailing addresses, a website, constituent category fields, and a relationship |
| `submit_gift_for_review` | Gift, pledge, and goal fields, plus tribute (honor/memorial) details |
| `submit_note_for_review` | Notes |
| `submit_event_registration_for_review` | Event registrations/invitations |
| `submit_appeal_request_for_review` | Appeal requests |

None of these five write to LGL directly — every submission lands in **Settings → Integration Queue → Unsaved** in LGL, where someone reviews and either saves or rejects it. Because of that, they're **exempt from `LGL_READ_ONLY`**: they stay available even when every other mutation tool is hidden, since they can't change data without a human clicking Save in LGL first.

**Setup:**
1. In LGL, go to *Settings → Integrations* and create (or reuse) a Custom Integration. Copy its listener URL.
2. Set `LGL_INTEGRATION_LISTENER_URL` to that URL in your environment.
3. In that integration's *field mapping* screen, map the field names your submissions will use (e.g. `first_name`, `phone`, `email_2`, `gift_amount`, `note_text`) to the corresponding LGL fields. **The mapping lives entirely in LGL's UI, not in this server** — a field that isn't mapped is silently ignored by LGL rather than causing an error, so an unmapped submission may look successful (HTTP 200) while carrying no usable data. Repeating fields (phone/email/address) use LGL's "Record Type / #" grouping: slot 1 is the bare field name (`phone`, `email`), slots 2–3 use a numeric suffix (`phone_2`, `email_3`).
4. Because there's no LGL account whose mapping is identical out of the box, treat the field names above as a starting point and confirm against your own mapping screen before relying on a given tool.

**Known limitation:** mapping a field to *"LGL constituent ID"* to match/update an existing constituent by ID does not currently persist, at least when the integration's record-matching preference is set to email/name-based matching rather than ID-based. Matching therefore relies on `first_name` + `last_name` + `email` instead — omit any ID field from your mapping.

---

## Transport Selection

This server supports two communication transport standards:
- **Stdio Transport (Default):** The standard input/output process channel. Ideal for local programs like Claude Desktop or local command configurations.
- **Streamable HTTP Transport (SSE):** Runs a native HTTP server providing modern, stateful Server-Sent Events (SSE) over HTTP. Required for **GitHub Copilot**, Cursor's SSE mode, cloud containers, and systems that don't natively execute local Node.js processes.

### Running in Streamable HTTP Mode
To launch the server in Streamable HTTP mode, use the `--http` (or `--sse`) flag:
```bash
node index.js --http --port 3000
```
- **Port Selection:** Custom ports can be specified using `--port <number>` or the `PORT` environment variable (defaults to `3000`).
- **Secure Token Protection:** If you set `LGL_MCP_TOKEN` in your `.env` file, Bearer Token Authentication is strictly enforced. All client requests must include the header `Authorization: Bearer <your_token>`, or they will be rejected with `401 Unauthorized`.

---

## Integrating with AI Clients

This server can be integrated into any AI client, editor, or chat interface that supports the Model Context Protocol (MCP).

### 1. Claude Desktop
To utilize this server in the official Claude Desktop application, add the configuration to your `claude_desktop_config.json` file.

**File Location:**
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

**Configuration:**
```json
{
  "mcpServers": {
    "lgl-crm": {
      "command": "node",
      "args": ["C:\\path\\to\\your\\workspace\\folder\\index.js"],
      "env": {
        "LGL_API_KEY": "your_lgl_api_key_here"
      }
    }
  }
}
```

### 2. Cursor IDE (AI Code Editor)
Cursor supports custom MCP servers directly in its graphical user interface. You can connect using either Stdio (command) or Streamable HTTP (SSE):

**Option A: Local Stdio (Command)**
1. Open Cursor and navigate to **Settings** > **Features** > **MCP**.
2. Click **+ Add New MCP Server**.
3. Configure the fields in the popup:
   - **Name:** `lgl-crm`
   - **Type:** `command`
   - **Command:** `node C:\path\to\your\workspace\folder\index.js`
4. Click **Save**. Note: You must ensure that the `LGL_API_KEY` is set in your operating system environment variables or shell configuration so Cursor can inherit it.

**Option B: Streamable HTTP (SSE Mode)**
1. Start the LGL MCP server in HTTP mode: `node index.js --http --port 3000`
2. Navigate to **Settings** > **Features** > **MCP**.
3. Click **+ Add New MCP Server**.
4. Configure the fields in the popup:
   - **Name:** `lgl-crm-sse`
   - **Type:** `sse`
   - **URL:** `http://localhost:3000/mcp`
5. Click **Save**. Note: If `LGL_MCP_TOKEN` is enabled, ensure your editor includes the Bearer authorization header or connection config.

### 3. Windsurf IDE (AI Code Editor)
Windsurf supports native MCP configurations via its global config file.

**File Location:**
- **Windows:** `%USERPROFILE%\.codeium\windsurf\mcp_config.json`
- **macOS/Linux:** `~/.codeium/windsurf/mcp_config.json`

**Configuration:**
```json
{
  "mcpServers": {
    "lgl-crm": {
      "command": "node",
      "args": ["C:\\path\\to\\your\\workspace\\folder\\index.js"],
      "env": {
        "LGL_API_KEY": "your_lgl_api_key_here"
      }
    }
  }
}
```

### 4. LibreChat (Open-Source Chat UI)
LibreChat allows you to integrate MCP servers directly through its centralized config file `librechat.yaml`.

**Configuration in `librechat.yaml`:**
```yaml
mcpServers:
  lgl-crm:
    type: "stdio"
    command: "node"
    args: ["C:\\path\\to\\your\\workspace\\folder\\index.js"]
    env:
      LGL_API_KEY: "your_lgl_api_key_here"
```

### 5. Open WebUI (Local/Self-Hosted AI UI)
To add this to Open WebUI (commonly used with local Ollama instances):
1. Navigate to **Admin Settings** > **Connections** > **MCP**.
2. Click **Add Connection**.
3. Name the connection `lgl-crm`.
4. Enter the command configuration:
   - **Command:** `node C:\path\to\your\workspace\folder\index.js`
5. Click **Submit**. (Make sure the environment variable `LGL_API_KEY` is loaded on your host machine or docker run statement running the Open WebUI instance).

---

## Security & Data Privacy

Unlike other MCP integrations that route sensitive donor information through third-party services (like Zapier or Make), this server operates on a **direct local pipeline**:
- **Zero Third-Party Storage:** All constituent data, physical addresses, emails, phone numbers, and financial donations are sent directly from your computer to the official LGL API over secure, encrypted HTTPS.
- **Principle of Least Privilege:** You can easily restrict access to database modifications (e.g. deleting records) by commenting out or removing the corresponding tools in the `index.js` file before deployment.

---

## License

This project is open-source and free to adapt for non-profit organizations under the MIT License.

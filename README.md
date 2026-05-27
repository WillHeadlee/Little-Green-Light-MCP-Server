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
```

#### Optional: Read-Only Mode
Set `LGL_READ_ONLY=true` to refuse every `create_*`, `update_*`, `delete_*`, `record_*`, and `add_*` tool call. Mutation tools are also hidden from `tools/list` so the AI assistant doesn't try to call them. Recommended whenever you point the server at a live donor database from an exploratory chat session.
```env
LGL_READ_ONLY=true
```

All tools also publish MCP `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so clients can warn before destructive calls without depending on the server-side guard.

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

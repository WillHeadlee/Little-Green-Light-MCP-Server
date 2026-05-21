# Little Green Light (LGL) MCP Server

A direct, secure, and high-fidelity Model Context Protocol (MCP) Server for the Little Green Light CRM database. This server allows AI coding assistants and chat applications (like Claude Desktop, LibreChat, or Open WebUI) to securely interact with your donor database to search constituents, log gifts, categorize taxonomic groups, and generate reports locally without any third-party middleware (like Zapier).

---

## Features

- **Constituents & Core Management:** Search, retrieve, create, update, and delete constituent records.
- **Fundraising & Gifts:** Record new gifts, list transactions, search payments, and view campaigns, funds, appeals, and events.
- **Contact Sub-Resources:** Fully manage street addresses, phone numbers, email addresses, and web addresses for constituents.
- **Activities & Notes:** Log notes, write contact reports, track volunteer hours, and schedule reminders.
- **Groups & Memberships:** Organize constituents into customizable groups and membership levels.
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
Open `.env` in a text editor and replace the placeholder with your actual LGL API key:
```env
LGL_API_KEY=your_lgl_api_key_here
PORT=3000
```

#### Optional: Read-Only Mode
Set `LGL_READ_ONLY=true` to refuse every `create_*`, `update_*`, `delete_*`, `record_*`, and `add_*` tool call. Mutation tools are also hidden from `tools/list` so the AI assistant doesn't try to call them. Recommended whenever you point the server at a live donor database from an exploratory chat session.
```env
LGL_READ_ONLY=true
```

All tools also publish MCP `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so clients can warn before destructive calls without depending on the server-side guard.

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
Cursor supports custom MCP servers directly in its graphical user interface:
1. Open Cursor and navigate to **Settings** > **Features** > **MCP**.
2. Click **+ Add New MCP Server**.
3. Configure the fields in the popup:
   - **Name:** `lgl-crm`
   - **Type:** `command`
   - **Command:** `node C:\path\to\your\workspace\folder\index.js`
4. Click **Save**. Note: You must ensure that the `LGL_API_KEY` is set in your operating system environment variables or shell configuration so Cursor can inherit it.

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

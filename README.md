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

---

## Integrating with AI Clients

### Integrating with Claude Desktop
To utilize this server in the official Claude Desktop application, add the server configuration to your `claude_desktop_config.json` file.

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
*Note: Make sure to replace `C:\\path\\to\\your\\workspace\\folder` with the actual absolute path to where this server is located on your machine.*

---

## Security & Data Privacy

Unlike other MCP integrations that route sensitive donor information through third-party services (like Zapier or Make), this server operates on a **direct local pipeline**:
- **Zero Third-Party Storage:** All constituent data, physical addresses, emails, phone numbers, and financial donations are sent directly from your computer to the official LGL API over secure, encrypted HTTPS.
- **Principle of Least Privilege:** You can easily restrict access to database modifications (e.g. deleting records) by commenting out or removing the corresponding tools in the `index.js` file before deployment.

---

## License

This project is open-source and free to adapt for non-profit organizations under the MIT License.

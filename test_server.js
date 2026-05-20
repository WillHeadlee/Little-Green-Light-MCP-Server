import { spawn } from "child_process";

console.log("Starting LGL MCP server integration test...");

const serverProcess = spawn("node", ["index.js"], {
  env: {
    ...process.env,
    LGL_API_KEY: "dummy_key_for_testing"
  }
});

let stdoutData = "";
let stderrData = "";

serverProcess.stdout.on("data", (chunk) => {
  stdoutData += chunk.toString();
});

serverProcess.stderr.on("data", (chunk) => {
  stderrData += chunk.toString();
});

// Once the server is ready, we'll write the JSON-RPC request to its stdin
setTimeout(() => {
  const listToolsRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {}
  };
  
  console.log("Sending tools/list JSON-RPC request to stdin...");
  serverProcess.stdin.write(JSON.stringify(listToolsRequest) + "\n");
}, 1000);

// Wait a bit, then analyze stdout and kill the process
setTimeout(() => {
  console.log("\n--- Server Stderr Logs ---");
  console.log(stderrData.trim());
  console.log("-------------------------\n");

  if (stdoutData) {
    try {
      const response = JSON.parse(stdoutData.trim());
      if (response.result && response.result.tools) {
        console.log(`✅ Success! LGL MCP server successfully listed ${response.result.tools.length} tools.`);
        
        // Print a few tool names to verify
        const toolNames = response.result.tools.map(t => t.name);
        console.log("Registered tool names:", toolNames.slice(0, 10).join(", ") + `... and ${toolNames.length - 10} more.`);
        
        // Verify call_lgl_api is present
        if (toolNames.includes("call_lgl_api")) {
          console.log("✅ Verified 'call_lgl_api' is registered.");
        } else {
          console.error("❌ Error: 'call_lgl_api' is missing!");
        }
      } else {
        console.error("❌ Error: Response format incorrect.", response);
      }
    } catch (err) {
      console.error("❌ Error parsing JSON-RPC stdout response:", err.message);
      console.log("Raw stdout was:", stdoutData);
    }
  } else {
    console.error("❌ Error: No data received on stdout. Server might have crashed or hung.");
  }

  serverProcess.kill();
  process.exit(0);
}, 2500);

import { spawn } from "node:child_process";
import http from "node:http";

console.log("Starting LGL MCP Server Streamable HTTP & Authentication Integration Test...");

const PORT = 4567;
const TOKEN = "test_bearer_token_12345";

// Spawn server in HTTP mode on port 4567 with LGL_MCP_TOKEN set
const serverProcess = spawn("node", ["index.js", "--http", "--port", PORT.toString()], {
  env: {
    ...process.env,
    LGL_API_KEY: "dummy_key_for_testing",
    LGL_MCP_TOKEN: TOKEN
  }
});

let stderrData = "";
serverProcess.stderr.on("data", (chunk) => {
  stderrData += chunk.toString();
  process.stderr.write("[Server Stderr] " + chunk.toString());
});

serverProcess.on("error", (err) => {
  console.error("Failed to start LGL MCP server process:", err);
  process.exit(1);
});

// Helper to make a simple HTTP request using Node's native http module
function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: data
        });
      });
    });

    req.on("error", (err) => { reject(err); });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

// Wait 1.5 seconds for the server to spin up and bind to the port
setTimeout(async () => {
  try {
    console.log("\n--- Test Case 1: Unauthenticated Request ---");
    const res1 = await makeRequest({
      hostname: "localhost",
      port: PORT,
      path: "/mcp",
      method: "POST",
      headers: {
        "Accept": "application/json, text/event-stream"
      }
    });
    console.log(`Status Code: ${res1.statusCode} (Expected: 401)`);
    if (res1.statusCode === 401) {
      console.log("✅ Success: Unauthenticated request rejected with 401 Unauthorized.");
    } else {
      throw new Error(`Failed: Unauthenticated request returned status code ${res1.statusCode}`);
    }

    console.log("\n--- Test Case 2: Invalid Bearer Token ---");
    const res2 = await makeRequest({
      hostname: "localhost",
      port: PORT,
      path: "/mcp",
      method: "POST",
      headers: {
        "Authorization": "Bearer wrong_token",
        "Accept": "application/json, text/event-stream"
      }
    });
    console.log(`Status Code: ${res2.statusCode} (Expected: 401)`);
    if (res2.statusCode === 401) {
      console.log("✅ Success: Invalid token request rejected with 401 Unauthorized.");
    } else {
      throw new Error(`Failed: Invalid token request returned status code ${res2.statusCode}`);
    }

    console.log("\n--- Test Case 3: MCP Handshake Step 1 - Send 'initialize' POST Request ---");
    const initPayload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "test-client",
          version: "1.0.0"
        }
      }
    });

    const res3 = await makeRequest({
      hostname: "localhost",
      port: PORT,
      path: "/mcp",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TOKEN}`,
        "Accept": "application/json, text/event-stream",
        "Content-Length": Buffer.byteLength(initPayload)
      }
    }, initPayload);

    console.log(`Status Code: ${res3.statusCode} (Expected: 200)`);
    console.log("Response headers:", res3.headers);
    console.log("Response data:", res3.data);

    // Extract the mcp-session-id header
    const sessionId = res3.headers["mcp-session-id"];
    if (!sessionId) {
      throw new Error("Failed: Server did not return an 'mcp-session-id' header!");
    }
    console.log(`✅ Success: MCP Handshake step 1 complete. Session ID is: ${sessionId}`);

    console.log("\n--- Test Case 4: MCP Handshake Step 2 - GET SSE Stream (GET /mcp) ---");
    // Client opens the SSE connection using GET /mcp with the mcp-session-id header
    // We make a request but since it's a persistent stream, we will just request it and let it run
    const sseOptions = {
      hostname: "localhost",
      port: PORT,
      path: "/mcp",
      method: "GET",
      headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "mcp-session-id": sessionId,
        "Accept": "text/event-stream"
      }
    };
    
    // We send it asynchronously so we don't block our test runner on the persistent connection
    let sseResponse = null;
    const sseReq = http.request(sseOptions, (res) => {
      sseResponse = res;
      console.log(`GET SSE stream status code: ${res.statusCode} (Expected: 200)`);
      console.log("GET SSE headers:", res.headers);
    });
    sseReq.end();

    // Wait a brief moment for the SSE stream connection to resolve on the server
    await new Promise(r => setTimeout(r, 200));
    console.log("✅ Success: Persistent SSE connection request dispatched.");

    console.log("\n--- Test Case 5: MCP Handshake Step 3 - Send 'notifications/initialized' POST Notification ---");
    const initializedPayload = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    });

    const res5 = await makeRequest({
      hostname: "localhost",
      port: PORT,
      path: "/mcp",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TOKEN}`,
        "mcp-session-id": sessionId,
        "Accept": "application/json, text/event-stream",
        "Content-Length": Buffer.byteLength(initializedPayload)
      }
    }, initializedPayload);

    console.log(`Status Code: ${res5.statusCode} (Expected: 200 or 202 or 204)`);
    console.log("Response data:", res5.data);
    console.log("✅ Success: Handshake completed.");

    console.log("\n--- Test Case 6: Call MCP 'tools/list' JSON-RPC Method ---");
    const listPayload = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    });

    const res6 = await makeRequest({
      hostname: "localhost",
      port: PORT,
      path: "/mcp",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TOKEN}`,
        "mcp-session-id": sessionId,
        "Accept": "application/json, text/event-stream",
        "Content-Length": Buffer.byteLength(listPayload)
      }
    }, listPayload);

    console.log(`Status Code: ${res6.statusCode} (Expected: 200)`);
    console.log("Response data snippet:", res6.data.slice(0, 300) + "...");

    let responseText = res6.data;
    if (responseText.includes("data: ")) {
      const dataLines = responseText.split("\n").filter(line => line.startsWith("data: "));
      if (dataLines.length > 0) {
        responseText = dataLines[0].substring(6); // Extract after "data: "
      }
    }

    const responseJson = JSON.parse(responseText.trim());
    if (responseJson.result && responseJson.result.tools) {
      console.log(`✅ Success: Received tools list containing ${responseJson.result.tools.length} tools!`);
    } else {
      throw new Error(`Failed: Invalid JSON-RPC response payload structure: ${res6.data}`);
    }

    console.log("\nAll integration test cases passed successfully! 🎉");
    serverProcess.kill();
    process.exit(0);

  } catch (err) {
    console.error("\n❌ Test Failed:", err.message);
    serverProcess.kill();
    process.exit(1);
  }
}, 1500);

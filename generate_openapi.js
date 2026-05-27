import fs from "node:fs";
import path from "node:path";

console.log("Generating complete LGL Swagger 2.0 specification...");

const txtPath = "lgl-api-endpoints.txt";
const jsonPath = "lgl-openapi.json";

if (!fs.existsSync(txtPath)) {
  console.error(`Error: Reference file ${txtPath} not found!`);
  process.exit(1);
}

const lines = fs.readFileSync(txtPath, "utf-8").split("\n");

const swagger = {
  swagger: "2.0",
  info: {
    title: "Little Green Light CRM API",
    description: "Complete, 141-endpoint REST API connector for the Little Green Light donor database. Exposes all core resources, sub-resources, campaigns, fundraising, activities, and customization tools.",
    version: "1.0.0"
  },
  host: "api.littlegreenlight.com",
  basePath: "/api/v1",
  schemes: ["https"],
  securityDefinitions: {
    api_key: {
      type: "apiKey",
      name: "access_token",
      in: "query",
      description: "Enter your raw Little Green Light API Key generated in Settings > Integration > API Keys."
    }
  },
  security: [
    {
      api_key: []
    }
  ],
  paths: {}
};

// Formatting helpers
function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function getOperationId(method, cleanPath) {
  // e.g. /constituents/{constituent_id}/gifts -> listConstituentGifts
  const parts = cleanPath.split("/").filter(p => p && !p.startsWith("{"));
  const cleanParts = parts.map((p, idx) => idx === 0 ? p : capitalize(p.replace(/_([a-z])/g, (_, g) => g.toUpperCase())));
  const name = cleanParts.join("");
  
  if (method === "GET") {
    if (cleanPath.endsWith("}") || cleanPath.includes("search") || cleanPath.endsWith("metadata")) {
      return `get${name}`;
    }
    return `list${name}`;
  } else if (method === "POST") {
    return `create${name}`;
  } else if (method === "PATCH") {
    return `update${name}`;
  } else if (method === "DELETE") {
    return `delete${name}`;
  }
  return `${method.toLowerCase()}${name}`;
}

let count = 0;

for (const line of lines) {
  const match = line.trim().match(/^(GET|POST|PATCH|DELETE)\s+(\/api\/v1\/\S+)\s+(?:\|\s+(.+))?$/);
  if (!match) continue;

  const method = match[1];
  const fullPath = match[2];
  const rawDesc = match[3] ? match[3].trim() : `LGL API endpoint for ${fullPath}`;

  // Clean path to remove /api/v1 prefix
  const cleanPath = fullPath.replace("/api/v1", "");

  if (!swagger.paths[cleanPath]) {
    swagger.paths[cleanPath] = {};
  }

  const operationId = getOperationId(method, cleanPath);
  const parameters = [];

  // Parse path parameters, e.g. {id} or {constituent_id}
  const pathParams = cleanPath.match(/{[a-zA-Z_]+}/g);
  if (pathParams) {
    for (const p of pathParams) {
      const name = p.replace("{", "").replace("}", "");
      parameters.push({
        name: name,
        in: "path",
        required: true,
        type: "integer",
        description: `The ${name} parameter`
      });
    }
  }

  // Add default query parameters for lists
  if (method === "GET" && !cleanPath.endsWith("}") && !cleanPath.includes("search")) {
    parameters.push({
      name: "limit",
      in: "query",
      type: "integer",
      default: 50,
      description: "Maximum records to return"
    });
    parameters.push({
      name: "offset",
      in: "query",
      type: "integer",
      default: 0,
      description: "Number of records to skip"
    });
  }

  // Add search query for search endpoints
  if (cleanPath.includes("search") && method === "GET") {
    parameters.push({
      name: "q",
      in: "query",
      type: "string",
      required: true,
      description: "Search term"
    });
  }

  // Add generic body schema for modifications
  if (method === "POST" || method === "PATCH") {
    parameters.push({
      name: "body",
      in: "body",
      required: true,
      schema: {
        type: "object",
        description: `JSON payload for ${operationId}`
      }
    });
  }

  swagger.paths[cleanPath][method.toLowerCase()] = {
    summary: rawDesc,
    description: rawDesc,
    operationId: operationId,
    parameters: parameters,
    responses: {
      "200": {
        "description": "Success"
      }
    }
  };

  count++;
}

// Custom overrides for specific critical schemas to provide a rich UI experience
if (swagger.paths["/constituents"] && swagger.paths["/constituents"]["post"]) {
  swagger.paths["/constituents"]["post"].parameters[0].schema = {
    type: "object",
    properties: {
      first_name: { type: "string" },
      last_name: { type: "string" },
      organization_name: { type: "string" },
      constituent_type: { type: "string", enum: ["individual", "organization"], default: "individual" }
    }
  };
}

fs.writeFileSync(jsonPath, JSON.stringify(swagger, null, 2), "utf-8");
console.log(`Successfully generated LGL Swagger file at ${jsonPath} containing all ${count} REST API endpoints! 🎉`);

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";
import { requireBearerToken } from "../auth/bearer.js";
import {
  createRateLimiter,
  rateLimitMiddleware
} from "../security/rateLimit.js";
import { executeTool } from "./tools.js";

function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }]
  };
}

function createServer() {
  const server = new McpServer({ name: "heisenberg", version: "1.0.0" });
  const register = (name, description, inputSchema, handler) => {
    server.registerTool(name, { description, inputSchema }, async (args) => {
      try {
        return result(await handler(args));
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error.message }]
        };
      }
    });
  };

  register("get_current_menu", "Get this week's confirmed or active menu.", {}, () =>
    executeTool("get_current_menu")
  );
  register("get_dish_list", "Get the full master dish list.", {}, () =>
    executeTool("get_dish_list")
  );
  register(
    "add_dish",
    "Add a dish to the master list.",
    {
      name: z.string().min(1),
      category: z.enum(["carb_heavy", "chicken_main", "paneer_main", "sabzi", "dry_chicken"]),
      tags: z.array(z.string()).optional()
    },
    (args) => executeTool("add_dish", args)
  );
  register(
    "disable_dish",
    "Disable a dish by name or id.",
    { name_or_id: z.string().min(1) },
    (args) => executeTool("disable_dish", args)
  );
  register(
    "update_dish",
    "Rename, recategorise, retag, enable, or disable an existing dish.",
    {
      name_or_id: z.string().min(1),
      name: z.string().min(1).optional(),
      category: z.enum(["carb_heavy", "chicken_main", "paneer_main", "sabzi", "dry_chicken"]).optional(),
      tags: z.array(z.string()).optional(),
      active: z.boolean().optional()
    },
    (args) => executeTool("update_dish", args)
  );
  register(
    "update_preference",
    "Update a validated meal-planning preference. custom_rules use declarative formats: " +
      "never:<term>, max_category:<category>:<0-5>, require_main:<dish>, " +
      "not_on:<day>:<dish>, or pair:<dish>|<dish>.",
    { key: z.string().min(1), value: z.unknown() },
    (args) => executeTool("update_preference", args)
  );
  register("get_preferences", "Get all preferences.", {}, () =>
    executeTool("get_preferences")
  );
  register("regenerate_menu", "Generate a fresh menu for next week.", {}, () =>
    executeTool("regenerate_menu")
  );
  register(
    "confirm_menu",
    "Confirm the newest draft menu.",
    { menu_id: z.string().uuid().optional() },
    (args) => executeTool("confirm_menu", args)
  );
  register(
    "modify_menu_day",
    "Modify fields for a day in the latest menu.",
    {
      menu_id: z.string().uuid().optional(),
      day: z.enum(["Monday", "Tuesday", "Thursday", "Friday", "Saturday"]),
      main_dish: z.string().optional(),
      side_chicken: z.string().nullable().optional(),
      prep_notes: z.string().optional(),
      cook_notes: z.string().optional()
    },
    (args) => executeTool("modify_menu_day", args)
  );
  register(
    "get_menu_history",
    "Get the most recent N weekly menus.",
    { weeks: z.number().int().min(1).max(52).default(4) },
    (args) => executeTool("get_menu_history", args)
  );
  return server;
}

export function mountMcpServer(app) {
  const bearerToken = process.env.MCP_BEARER_TOKEN;
  if (!bearerToken) {
    throw new Error("MCP_BEARER_TOKEN is required; refusing to start an unauthenticated MCP server.");
  }
  app.use("/mcp", requireBearerToken(bearerToken, "heisenberg-mcp"));
  app.use(
    "/mcp",
    rateLimitMiddleware(createRateLimiter({ limit: 30, windowMs: 60_000 }))
  );
  app.use("/mcp", express.json({ limit: "32kb" }));
  app.post("/mcp", async (request, response) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    response.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("MCP request failed:", error);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  });
  app.get("/mcp", (_request, response) => response.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed" },
    id: null
  }));
  app.delete("/mcp", (_request, response) => response.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed" },
    id: null
  }));
}

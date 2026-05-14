import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildTools, isWriteTool, type ToolDef } from "./tools";
import { vaultService, VaultError } from "../vault/service";
import { logger } from "../lib/logger";
import { redactError } from "../lib/redact";
import { consumeWrite } from "./rateLimit";

function zodToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
} {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    properties[key] = zodFieldToSchema(value as z.ZodType);
    if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
      required.push(key);
    }
  }

  return { type: "object", properties, required };
}

function zodFieldToSchema(field: z.ZodType): Record<string, unknown> {
  const description =
    (field as unknown as { _def: { description?: string } })._def.description;
  const base: Record<string, unknown> = {};
  if (description) base["description"] = description;

  if (field instanceof z.ZodString) return { ...base, type: "string" };
  if (field instanceof z.ZodNumber) return { ...base, type: "number" };
  if (field instanceof z.ZodBoolean) return { ...base, type: "boolean" };
  if (field instanceof z.ZodArray) {
    return {
      ...base,
      type: "array",
      items: zodFieldToSchema(field.element as z.ZodType),
    };
  }
  if (field instanceof z.ZodEnum) {
    return { ...base, type: "string", enum: field.options };
  }
  if (field instanceof z.ZodOptional) {
    return zodFieldToSchema(field.unwrap() as z.ZodType);
  }
  if (field instanceof z.ZodDefault) {
    return zodFieldToSchema(
      (field as z.ZodDefault<z.ZodType>)._def.innerType as z.ZodType,
    );
  }
  if (field instanceof z.ZodRecord) {
    return { ...base, type: "object", additionalProperties: true };
  }
  if (field instanceof z.ZodObject) {
    return { ...base, ...zodToJsonSchema(field) };
  }
  return { ...base };
}

export function createMcpServer(opts: {
  sessionKey: string;
  maxWritesPerHour: number;
}): Server {
  const tools: ToolDef[] = buildTools();
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    {
      name: "obsidian-mcp-railway",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const tool = toolMap.get(name);
    if (!tool) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: `Unknown tool: ${name}`,
              hint: "Call ListTools to see available tools.",
            }),
          },
        ],
      };
    }

    if (isWriteTool(name)) {
      const { allowed, remaining, resetMs } = await consumeWrite(
        `writes:${opts.sessionKey}`,
        opts.maxWritesPerHour,
      );
      if (!allowed) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: `Write rate limit exceeded (${opts.maxWritesPerHour}/hour).`,
                hint: `Wait ~${Math.ceil(resetMs / 60_000)} minutes for the rolling window to reset, or raise MAX_WRITES_PER_HOUR on Railway.`,
              }),
            },
          ],
        };
      }
      logger.info({ tool: name, remaining }, "write tool invoked");
    } else {
      logger.info({ tool: name }, "read tool invoked");
    }

    try {
      const parsed = tool.inputSchema.parse(args ?? {});
      const result = await tool.handler(parsed as Record<string, unknown>);
      return result as { content: { type: "text"; text: string }[] };
    } catch (err) {
      const message = redactError(err);
      const hint = err instanceof VaultError ? err.hint : undefined;
      logger.warn({ tool: name, err: message }, "tool error");
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, error: message, hint }),
          },
        ],
      };
    }
  });

  // Single resource: vault README, if present
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    try {
      await vaultService.sync();
      const exists = await vaultService.exists("README.md");
      if (!exists) return { resources: [] };
      return {
        resources: [
          {
            uri: "vault://README.md",
            name: "Vault README",
            description: "Vault root README explaining organization conventions.",
            mimeType: "text/markdown",
          },
        ],
      };
    } catch {
      return { resources: [] };
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (uri !== "vault://README.md") {
      throw new Error(`Unknown resource: ${uri}`);
    }
    const text = await vaultService.readFile("README.md");
    return {
      contents: [{ uri, mimeType: "text/markdown", text }],
    };
  });

  return server;
}

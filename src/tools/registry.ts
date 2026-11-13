import { z } from "zod";
import type { ToolDefinition } from "../providers/types.js";
import type { RegisteredTool, Tool } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register<TArgs>(tool: Tool<TArgs>): void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)) {
      throw new Error(`Invalid tool name: ${tool.name}`);
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`A tool named "${tool.name}" is already registered.`);
    }

    const parameters = z.toJSONSchema(tool.schema);
    delete parameters.$schema;
    const definition: ToolDefinition = {
      name: tool.name,
      description: tool.description,
      parameters: parameters as Record<string, unknown>,
    };
    this.tools.set(tool.name, {
      definition,
      schema: tool.schema,
      execute: async (args, context) => tool.execute(args as TArgs, context),
    });
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map(({ definition }) => structuredClone(definition));
  }

  get size(): number {
    return this.tools.size;
  }
}

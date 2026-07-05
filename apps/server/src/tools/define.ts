import { z } from "zod";
import type { ToolContext } from "./context.js";

export type { ToolContext };

/** A backend tool exposed to the LLM as an OpenAI-style function. */
export interface LocalTool {
  name: string;
  description: string;
  parameters: unknown; // JSON schema, generated from the zod schema
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

/**
 * Define a local tool from a single zod schema, which is the source of truth:
 * it generates the JSON schema the model sees AND validates + types the args
 * passed to execute(). A tool body is therefore only its own logic — no manual
 * schema, no arg parsing, no fetch/error boilerplate (see ToolContext).
 *
 * A thrown error (including a zod validation failure) is caught by the runner
 * and returned to the model as text, so execute() can just throw.
 */
export function defineTool<S extends z.ZodType>(spec: {
  name: string;
  description: string;
  schema: S;
  execute(args: z.infer<S>, ctx: ToolContext): Promise<string>;
}): LocalTool {
  const { $schema, ...parameters } = z.toJSONSchema(spec.schema) as Record<string, unknown>;
  return {
    name: spec.name,
    description: spec.description,
    parameters,
    run: (raw, ctx) => spec.execute(spec.schema.parse(raw), ctx),
  };
}

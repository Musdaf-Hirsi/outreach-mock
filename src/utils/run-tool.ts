import type { z } from "zod";
import type { Tool } from "@mastra/core/tools";
import { RuntimeContext } from "@mastra/core/runtime-context";

// Thin typed wrapper around a Mastra tool's `.execute`. `execute` is typed
// optional on `Tool` (a tool created without one is technically valid), so
// calling it directly needs either a non-null assertion or a cast — call
// sites across this project were reaching for `(tool.execute as any)(...)`,
// which throws away the real input/output typing Zod already gives us for
// no reason beyond silencing that one optionality check. This does the same
// non-null assertion in one place, while keeping full inference of the
// tool's actual inputSchema/outputSchema types at every call site.
export function runTool<TSchemaIn extends z.ZodSchema, TSchemaOut extends z.ZodSchema>(
  tool: Tool<TSchemaIn, TSchemaOut>,
  // z.input, not z.infer (= z.output): fields with a Zod `.default()` are
  // optional on the way in and only become required once Zod actually
  // applies the default during parsing. Using z.infer here was demanding
  // every call site spell out defaulted fields explicitly, which is exactly
  // the kind of real type gap the old `as any` cast was silently hiding.
  context: z.input<TSchemaIn>,
): Promise<z.infer<TSchemaOut>> {
  if (!tool.execute) {
    throw new Error(`Tool "${tool.id}" has no execute function.`);
  }
  // None of these tools read runtimeContext (it's an empty/unused Mastra
  // dependency-injection mechanism here) — it's only required by the type,
  // not by anything these tools actually do, so a fresh empty instance is
  // correct rather than a placeholder to work around.
  return tool.execute({ context, runtimeContext: new RuntimeContext() });
}

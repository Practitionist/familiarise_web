import { z } from "zod";

const functionContextSchema = z.object({
  deploy: z.object({ context: z.string(), id: z.string().optional() }),
});

export type NetlifyDeploy = z.infer<typeof functionContextSchema>["deploy"];

/** The deploy a Netlify function belongs to, from its second handler argument. */
export function netlifyDeploy(context: unknown): NetlifyDeploy | null {
  const parsed = functionContextSchema.safeParse(context);
  return parsed.success ? parsed.data.deploy : null;
}

/**
 * The non-production deploy context that must not run scheduled or background
 * work, else null. A runtime that passes no context is not refused.
 */
export function offProductionDeploy(context: unknown): string | null {
  const deploy = netlifyDeploy(context);
  return deploy && deploy.context !== "production" ? deploy.context : null;
}

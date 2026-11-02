import { z } from "zod";

/** The public account menu's view of the dashboard switcher: where each facet goes, nothing else. */
export const DashboardFacetsResponseSchema = z.object({
  facets: z.array(
    z.object({
      kind: z.enum([
        "expert",
        "client",
        "workspace",
        "organization",
        "admin",
        "staff",
      ]),
      key: z.string(),
      label: z.string(),
      href: z.string(),
    }),
  ),
});

export type DashboardFacetsResponse = z.infer<
  typeof DashboardFacetsResponseSchema
>;

import { z } from "zod";

/** Every Library tab; each role shows a subset in its own order. */
export const LibraryTabSchema = z.enum([
  "purchases",
  "recordings",
  "documents",
]);

export type LibraryTab = z.infer<typeof LibraryTabSchema>;

/** The requested `?tab=` when this viewer has that tab, else their first one. */
export function resolveLibraryTab<T extends LibraryTab>(
  raw: string | string[] | undefined,
  available: readonly [T, ...T[]],
): T {
  const parsed = LibraryTabSchema.safeParse(raw);
  return (
    available.find((tab) => parsed.success && tab === parsed.data) ??
    available[0]
  );
}

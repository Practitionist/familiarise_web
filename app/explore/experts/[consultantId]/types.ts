import type { getConsultantDetail } from "@/lib/data/consultant-detail";

// Inferred from the lib/data fetcher so plan prices stay number — the raw
// Prisma payload (TConsultantDetailData) re-introduces bigint money (#780)
export type ConsultantDetailData = NonNullable<
  Awaited<ReturnType<typeof getConsultantDetail>>
>;

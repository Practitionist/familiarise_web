import { z } from "zod";

/** Each Sell page's `?tab=`; an unknown or missing value opens the first. */
export const SELL_TAB_SCHEMAS = {
  sessions: z.enum(["consultations", "subscriptions"]).catch("consultations"),
  programs: z.enum(["webinars", "classes"]).catch("webinars"),
  products: z.enum(["digital", "replays"]).catch("digital"),
};

export type SellPage = keyof typeof SELL_TAB_SCHEMAS;
export type SessionsTab = z.infer<typeof SELL_TAB_SCHEMAS.sessions>;
export type ProgramsTab = z.infer<typeof SELL_TAB_SCHEMAS.programs>;
export type ProductsTab = z.infer<typeof SELL_TAB_SCHEMAS.products>;
export type SellTab = SessionsTab | ProgramsTab | ProductsTab;

/** Every kind the "+ New" picker creates; its editor is `offerings/<kind>/…`. */
export const SellableKindSchema = z.enum([
  "consultation",
  "subscription",
  "webinar",
  "class",
  "digital-product",
]);

export type SellableKind = z.infer<typeof SellableKindSchema>;

/** The Sell page and tab that lists each kind. */
export const SELL_HOME: Record<SellableKind, { page: SellPage; tab: SellTab }> =
  {
    consultation: { page: "sessions", tab: "consultations" },
    subscription: { page: "sessions", tab: "subscriptions" },
    webinar: { page: "programs", tab: "webinars" },
    class: { page: "programs", tab: "classes" },
    "digital-product": { page: "products", tab: "digital" },
  };

const sellPath = (page: SellPage, tab?: SellTab) =>
  tab ? `sell/${page}?tab=${tab}` : `sell/${page}`;

export function sellPageHref(
  consultantId: string,
  page: SellPage,
  tab?: SellTab,
): string {
  return `/dashboard/consultant/${consultantId}/${sellPath(page, tab)}`;
}

/** The list for an `offerings/<kind>` segment, relative to the expert's dashboard. */
export function sellHomePath(segment: string | undefined): string {
  const kind = SellableKindSchema.safeParse(segment);
  if (!kind.success) return sellPath("sessions");
  const { page, tab } = SELL_HOME[kind.data];
  return sellPath(page, tab);
}

/** Where an editor returns after a save: the list that shows this kind. */
export function sellHomeHref(consultantId: string, kind: SellableKind): string {
  return `/dashboard/consultant/${consultantId}/${sellHomePath(kind)}`;
}

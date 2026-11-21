/**
 * On-demand purges for the ISR'd public surfaces.
 *
 * The landing page and the two explore directories are prerendered and served
 * from the CDN with revalidate windows measured in minutes to an hour, so a
 * publish is invisible until the window lapses unless the write path says so.
 * These helpers are that "say so".
 *
 * Two mechanisms, because the surfaces are not uniformly cached:
 *  - `revalidateTag` clears the unstable_cache DATA entries (lib/data/home.ts,
 *    lib/data/explore-experts.ts), which are keyed by tag.
 *  - `revalidatePath` clears the rendered HTML in the Full Route Cache. It is
 *    always needed on top of the tag: purging the data alone leaves the already
 *    rendered document in place.
 *
 * The consultant and organisation DETAIL pages have no data cache at all — only
 * segment ISR — so for those the path purge is the whole mechanism.
 *
 * Call these AFTER the write commits (never inside a `$transaction` callback: a
 * rollback would leave the cache purged against unchanged data) and only for
 * transitions an anonymous visitor can actually observe. (#932)
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { PUBLIC_PRODUCTS_TAG } from "@/lib/digital-products/constants";

/** Next data-cache tag of the public Replays list. */
export const PUBLIC_RECORDINGS_TAG = "recordings";

const EXPERTS_DIRECTORY = "/explore/experts";
const ORGANISATIONS_DIRECTORY = "/explore/enterprise/organisations";
const PROGRAMS_DIRECTORY = "/explore/programs";
/** Next data-cache tag of the curated program sections and topic counts. */
const PROGRAMS_TAG = "programs";

/**
 * A consultant entered, left, or changed on the public surfaces — verification
 * flips, profile-content edits, soft/hard delete.
 *
 * `consultantProfileId` is the id the public profile route is keyed by; pass it
 * whenever the caller has it so that page is refreshed too rather than waiting
 * out its own window.
 */
export function purgeExpertSurfaces(consultantProfileId?: string | null): void {
  // Landing page reads getHomeExperts (tags: experts, home); the directory reads
  // getExpertsMetadata + getCuratedExperts (tag: experts).
  revalidateTag("experts");
  // Product and replay cards carry the creator's name and avatar.
  revalidateTag(PUBLIC_PRODUCTS_TAG);
  revalidateTag(PUBLIC_RECORDINGS_TAG);
  // A verification flip shows or hides the expert's programs (getCuratedPrograms, tag programs).
  revalidateTag(PROGRAMS_TAG);
  revalidatePath("/");
  revalidatePath(EXPERTS_DIRECTORY);
  revalidatePath(PROGRAMS_DIRECTORY);
  if (consultantProfileId) {
    revalidatePath(`${EXPERTS_DIRECTORY}/${consultantProfileId}`);
  }
}

/**
 * A review was written, edited, or removed. Reviews are rendered as testimonials
 * on the landing page and drive the denormalized `rating` that orders the
 * directory, so both the review tag and the expert surfaces have to go.
 */
export function purgeReviewSurfaces(consultantProfileId?: string | null): void {
  revalidateTag("reviews");
  purgeExpertSurfaces(consultantProfileId);
}

/**
 * An organisation entered, left, or changed on the public surfaces — isPublic
 * toggle, status move to/from ACTIVE, branding or name edits.
 *
 * Pass every slug the change touches. A slug rename moves the page's URL, so the
 * OLD slug has to be purged as well or its stale document keeps being served
 * under a path that no longer resolves.
 */
export function purgeOrgSurfaces(
  ...slugs: (string | null | undefined)[]
): void {
  revalidatePath(ORGANISATIONS_DIRECTORY);
  for (const slug of new Set(slugs.filter(Boolean))) {
    revalidatePath(`${ORGANISATIONS_DIRECTORY}/${slug}`);
  }
}

/** A digital product went on or off sale or its live listing changed: its page and the creator's profile section. */
export function purgeDigitalProductSurfaces(product: {
  consultantProfileId: string;
  slug: string;
}): void {
  revalidatePath(`${EXPERTS_DIRECTORY}/${product.consultantProfileId}`);
  revalidatePath(`/explore/products/${product.slug}`);
  revalidateTag(PUBLIC_PRODUCTS_TAG);
  revalidatePath("/explore/products");
}

/** Replays left the public listing or their listing changed: the Replays tab, its list cache and each detail page. */
export function purgeRecordingSurfaces(
  slugs: (string | null | undefined)[] = [],
): void {
  revalidateTag(PUBLIC_RECORDINGS_TAG);
  revalidatePath("/explore/products");
  for (const slug of new Set(slugs.filter(Boolean))) {
    revalidatePath(`/explore/recordings/${slug}`);
  }
}

/**
 * ConvertKit (Kit) Integration — Stubs
 *
 * These functions are placeholders for ConvertKit API integration.
 * Implement when subscriber count reaches 500+ (Issue #334).
 *
 * ConvertKit handles: newsletters, drip sequences, subscriber segmentation.
 * It is completely independent from the Resend/Novu notification pipeline.
 */

/**
 * Sync a subscriber email to ConvertKit.
 * Called from /api/newsletter/subscribe after saving to DB.
 */
export async function syncToConvertKit(
  email: string,
  tags?: string[],
): Promise<void> {
  // TODO: Issue #334 — Implement ConvertKit subscriber creation
  // API: POST https://api.convertkit.com/v3/forms/{formId}/subscribe
  // Required: CONVERTKIT_API_KEY, CONVERTKIT_FORM_ID env vars
  if (process.env.CONVERTKIT_API_KEY) {
    console.log(
      `[ConvertKit] Would sync ${email} with tags: ${tags?.join(", ") ?? "none"}`,
    );
  }
}

/**
 * Remove a subscriber from ConvertKit.
 * Called when a user unsubscribes from the newsletter.
 */
export async function removeFromConvertKit(email: string): Promise<void> {
  // TODO: Issue #334 — Implement ConvertKit subscriber removal
  // API: PUT https://api.convertkit.com/v3/unsubscribe
  if (process.env.CONVERTKIT_API_KEY) {
    console.log(`[ConvertKit] Would remove ${email}`);
  }
}

/**
 * Tag a subscriber in ConvertKit for segmentation.
 * Tags: consultant, consultee, tech, career, business, enterprise
 */
export async function tagSubscriber(
  email: string,
  tags: string[],
): Promise<void> {
  // TODO: Issue #334 — Implement ConvertKit tagging
  // API: POST https://api.convertkit.com/v3/tags/{tagId}/subscribe
  if (process.env.CONVERTKIT_API_KEY) {
    console.log(`[ConvertKit] Would tag ${email} with: ${tags.join(", ")}`);
  }
}

/**
 * Create a broadcast in ConvertKit (for blog post notifications).
 * Called from the Directus webhook handler when a new blog post is published.
 */
export async function createBroadcast(params: {
  subject: string;
  content: string;
  description?: string;
}): Promise<void> {
  // TODO: Issue #334 — Implement ConvertKit broadcast creation
  // API: POST https://api.convertkit.com/v3/broadcasts
  if (process.env.CONVERTKIT_API_KEY) {
    console.log(`[ConvertKit] Would create broadcast: "${params.subject}"`);
  }
}

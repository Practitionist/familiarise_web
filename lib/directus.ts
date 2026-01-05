import { createDirectus, rest, readItems, readItem } from "@directus/sdk";

// =============================================================================
// Type Definitions for CMS Content
// =============================================================================

/**
 * Blog post content type
 */
export interface CmsPost {
  id: string;
  status: "draft" | "published" | "archived";
  title: string;
  slug: string;
  excerpt: string | null;
  content: string; // Markdown content
  featured_image: string | null;
  category: string | null; // Reference to CmsCategory.id
  author_name: string | null;
  author_avatar: string | null;
  published_at: string | null;
  date_created: string;
  date_updated: string;
}

/**
 * Blog category type
 */
export interface CmsCategory {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  color: string;
  sort: number;
}

/**
 * Community thread type
 */
export interface CmsThread {
  id: string;
  status: "active" | "locked" | "archived";
  title: string;
  content: string; // Markdown content
  author_user_id: string; // Reference to app's user ID (string, not foreign key)
  category: string | null; // Reference to CmsCommunityCategory.id
  is_pinned: boolean;
  is_locked: boolean;
  reply_count: number;
  view_count: number;
  date_created: string;
  date_updated: string;
}

/**
 * Thread reply type (single level - no nested replies)
 */
export interface CmsReply {
  id: string;
  content: string; // Markdown content
  thread: string; // Reference to CmsThread.id
  author_user_id: string; // Reference to app's user ID (string, not foreign key)
  date_created: string;
  date_updated: string;
}

/**
 * Community category type
 */
export interface CmsCommunityCategory {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  color: string;
  icon: string | null;
  sort: number;
}

/**
 * Directus schema definition for type-safe SDK operations
 */
interface DirectusSchema {
  posts: CmsPost[];
  categories: CmsCategory[];
  threads: CmsThread[];
  replies: CmsReply[];
  community_categories: CmsCommunityCategory[];
}

// =============================================================================
// Client Initialization
// =============================================================================

const directusUrl = process.env.NEXT_PUBLIC_DIRECTUS_URL;

if (!directusUrl) {
  console.warn(
    "NEXT_PUBLIC_DIRECTUS_URL is not defined in environment variables.",
  );
  console.warn("Directus CMS features will be disabled.");
  console.warn(
    "To enable: Add NEXT_PUBLIC_DIRECTUS_URL to your .env.local file",
  );
  console.warn("Get it from: Directus Cloud Dashboard → Project Settings");
}

/**
 * Directus client instance
 * Will be null if NEXT_PUBLIC_DIRECTUS_URL is not configured
 */
export const directus = directusUrl
  ? createDirectus<DirectusSchema>(directusUrl).with(rest())
  : null;

/**
 * Check if Directus is properly configured
 */
export function isDirectusConfigured(): boolean {
  return !!directus;
}

// =============================================================================
// Blog Helper Functions
// =============================================================================

/**
 * Fetch published blog posts
 * @param limit - Maximum number of posts to return (default: 10)
 * @param offset - Number of posts to skip for pagination (default: 0)
 */
export async function getBlogPosts(
  limit = 10,
  offset = 0,
): Promise<CmsPost[]> {
  if (!directus) {
    console.warn("Directus not configured - returning empty posts array");
    return [];
  }

  try {
    const posts = await directus.request(
      readItems("posts", {
        filter: { status: { _eq: "published" } },
        sort: ["-published_at"],
        limit,
        offset,
      }),
    );
    return posts as CmsPost[];
  } catch (error) {
    console.error("Error fetching blog posts:", error);
    return [];
  }
}

/**
 * Fetch a single blog post by slug
 * @param slug - The post's URL slug
 */
export async function getBlogPost(slug: string): Promise<CmsPost | null> {
  if (!directus) {
    console.warn("Directus not configured - returning null");
    return null;
  }

  try {
    const posts = await directus.request(
      readItems("posts", {
        filter: {
          slug: { _eq: slug },
          status: { _eq: "published" },
        },
        limit: 1,
      }),
    );
    return (posts[0] as CmsPost) || null;
  } catch (error) {
    console.error(`Error fetching blog post with slug "${slug}":`, error);
    return null;
  }
}

/**
 * Fetch blog posts by category
 * @param categoryId - The category ID to filter by
 * @param limit - Maximum number of posts to return (default: 10)
 */
export async function getBlogPostsByCategory(
  categoryId: string,
  limit = 10,
): Promise<CmsPost[]> {
  if (!directus) {
    console.warn("Directus not configured - returning empty posts array");
    return [];
  }

  try {
    const posts = await directus.request(
      readItems("posts", {
        filter: {
          category: { _eq: categoryId },
          status: { _eq: "published" },
        },
        sort: ["-published_at"],
        limit,
      }),
    );
    return posts as CmsPost[];
  } catch (error) {
    console.error(
      `Error fetching blog posts for category "${categoryId}":`,
      error,
    );
    return [];
  }
}

/**
 * Fetch all blog categories
 */
export async function getBlogCategories(): Promise<CmsCategory[]> {
  if (!directus) {
    console.warn("Directus not configured - returning empty categories array");
    return [];
  }

  try {
    const categories = await directus.request(
      readItems("categories", {
        sort: ["sort", "name"],
      }),
    );
    return categories as CmsCategory[];
  } catch (error) {
    console.error("Error fetching blog categories:", error);
    return [];
  }
}

// =============================================================================
// Community Helper Functions
// =============================================================================

/**
 * Fetch active community threads
 * @param limit - Maximum number of threads to return (default: 20)
 * @param offset - Number of threads to skip for pagination (default: 0)
 */
export async function getCommunityThreads(
  limit = 20,
  offset = 0,
): Promise<CmsThread[]> {
  if (!directus) {
    console.warn("Directus not configured - returning empty threads array");
    return [];
  }

  try {
    const threads = await directus.request(
      readItems("threads", {
        filter: { status: { _eq: "active" } },
        sort: ["-is_pinned", "-date_created"],
        limit,
        offset,
      }),
    );
    return threads as CmsThread[];
  } catch (error) {
    console.error("Error fetching community threads:", error);
    return [];
  }
}

/**
 * Fetch threads by community category
 * @param categoryId - The community category ID to filter by
 * @param limit - Maximum number of threads to return (default: 20)
 */
export async function getThreadsByCategory(
  categoryId: string,
  limit = 20,
): Promise<CmsThread[]> {
  if (!directus) {
    console.warn("Directus not configured - returning empty threads array");
    return [];
  }

  try {
    const threads = await directus.request(
      readItems("threads", {
        filter: {
          category: { _eq: categoryId },
          status: { _eq: "active" },
        },
        sort: ["-is_pinned", "-date_created"],
        limit,
      }),
    );
    return threads as CmsThread[];
  } catch (error) {
    console.error(
      `Error fetching threads for category "${categoryId}":`,
      error,
    );
    return [];
  }
}

/**
 * Fetch a single community thread by ID
 * @param threadId - The thread's ID
 */
export async function getCommunityThread(
  threadId: string,
): Promise<CmsThread | null> {
  if (!directus) {
    console.warn("Directus not configured - returning null");
    return null;
  }

  try {
    const thread = await directus.request(readItem("threads", threadId));
    return thread as CmsThread;
  } catch (error) {
    console.error(`Error fetching thread "${threadId}":`, error);
    return null;
  }
}

/**
 * Fetch replies for a specific thread
 * @param threadId - The thread ID to fetch replies for
 * @param limit - Maximum number of replies to return (default: 50)
 * @param offset - Number of replies to skip for pagination (default: 0)
 */
export async function getThreadReplies(
  threadId: string,
  limit = 50,
  offset = 0,
): Promise<CmsReply[]> {
  if (!directus) {
    console.warn("Directus not configured - returning empty replies array");
    return [];
  }

  try {
    const replies = await directus.request(
      readItems("replies", {
        filter: { thread: { _eq: threadId } },
        sort: ["date_created"],
        limit,
        offset,
      }),
    );
    return replies as CmsReply[];
  } catch (error) {
    console.error(`Error fetching replies for thread "${threadId}":`, error);
    return [];
  }
}

/**
 * Fetch all community categories
 */
export async function getCommunityCategories(): Promise<CmsCommunityCategory[]> {
  if (!directus) {
    console.warn(
      "Directus not configured - returning empty community categories array",
    );
    return [];
  }

  try {
    const categories = await directus.request(
      readItems("community_categories", {
        sort: ["sort", "name"],
      }),
    );
    return categories as CmsCommunityCategory[];
  } catch (error) {
    console.error("Error fetching community categories:", error);
    return [];
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get the full URL for a Directus asset/file
 * @param fileId - The Directus file ID
 * @param transformations - Optional image transformations
 */
export function getDirectusAssetUrl(
  fileId: string | null,
  transformations?: {
    width?: number;
    height?: number;
    quality?: number;
    fit?: "cover" | "contain" | "inside" | "outside";
  },
): string | null {
  if (!fileId || !directusUrl) return null;

  let url = `${directusUrl}/assets/${fileId}`;

  if (transformations) {
    const params = new URLSearchParams();
    if (transformations.width) params.append("width", String(transformations.width));
    if (transformations.height) params.append("height", String(transformations.height));
    if (transformations.quality) params.append("quality", String(transformations.quality));
    if (transformations.fit) params.append("fit", transformations.fit);

    const queryString = params.toString();
    if (queryString) {
      url += `?${queryString}`;
    }
  }

  return url;
}

/**
 * Get instructions for manual Directus setup
 */
export function getDirectusSetupInstructions(): string {
  return `
To set up Directus CMS:

1. Sign up at https://directus.cloud
2. Create a new project ($15/month)
3. Create the following collections via Admin UI:
   - posts (blog articles)
   - categories (blog categories)
   - threads (community threads)
   - replies (thread replies)
   - community_categories

4. Generate a static access token:
   Settings → Access Tokens → Create

5. Enable MCP for AI content management:
   Settings → AI → MCP Server → Enable

6. Add to your .env.local:
   NEXT_PUBLIC_DIRECTUS_URL=https://your-project.directus.app
   DIRECTUS_ADMIN_TOKEN=your-static-access-token

Documentation: https://docs.directus.io/
`.trim();
}

export default directus;

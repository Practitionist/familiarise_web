import Link from "next/link";
import { listProductTopics } from "@/lib/data/digital-products-public";
import { productTopicPath } from "@/lib/explore/domain-slug";

const CHIP = "rounded-full px-3 py-1.5 text-sm transition-colors";
const ACTIVE = "bg-primary text-primary-foreground";
const IDLE =
  "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground";

/** One chip per field that has products, each a page of its own; "All" is the unfiltered library. */
export async function ProductTopicChips({
  activeId,
}: Readonly<{ activeId?: string }>) {
  const topics = await listProductTopics();
  if (topics.length === 0) return null;
  return (
    <nav aria-label="Browse by field" className="flex flex-wrap gap-2">
      <Link
        href="/explore/products"
        aria-current={activeId ? undefined : "page"}
        className={`${CHIP} ${activeId ? IDLE : ACTIVE}`}
      >
        All
      </Link>
      {topics.map((topic) => (
        <Link
          key={topic.id}
          href={productTopicPath(topic.name)}
          aria-current={topic.id === activeId ? "page" : undefined}
          className={`${CHIP} ${topic.id === activeId ? ACTIVE : IDLE}`}
        >
          {topic.name}
          <span className="ml-1.5 opacity-70">{topic.count}</span>
        </Link>
      ))}
    </nav>
  );
}

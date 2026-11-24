import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicBreadcrumb } from "@/components/explore/PublicBreadcrumb";
import { JsonLd } from "@/components/seo/JsonLd";
import { Button } from "@/components/ui/button";
import {
  getExpertsMetadata,
  getTopExpertsInDomain,
} from "@/lib/data/explore-experts";
import { domainPath, findDomainBySlug } from "@/lib/explore/domain-slug";
import { cn } from "@/utils/tailwind";
import { fieldDetail } from "@/components/home/fields";
import ExpertMiniCard from "../../components/ExpertMiniCard";

// Same cache window as the listing it summarises; the domain list and the
// expert rows are shared data-cache entries, so a profile edit refreshes both.
export const revalidate = 300;

export function generateStaticParams() {
  return [];
}

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

type Params = Promise<{ domain: string }>;

async function loadDomain(slug: string) {
  const metadata = await getExpertsMetadata();
  const domain = findDomainBySlug(metadata.domains, slug);
  if (!domain) return null;
  const count =
    metadata.consultantMetadata.consultantsByDomain.find(
      (entry) => entry.id === domain.id,
    )?.consultantCount ?? 0;
  const subdomains = metadata.subdomains.filter(
    (subdomain) => subdomain.domainId === domain.id,
  );
  return { domain, count, domains: metadata.domains, subdomains };
}

export async function generateMetadata({
  params,
}: Readonly<{ params: Params }>): Promise<Metadata> {
  const { domain: slug } = await params;
  const found = await loadDomain(slug).catch(() => null);
  if (!found) return { robots: { index: false } };
  const { domain, count } = found;
  const title = `${domain.name} experts and mentors | Familiarise`;
  const who = count > 0 ? `${count} vetted` : "vetted";
  const description = `Book a session with ${who} ${domain.name.toLowerCase()} experts. Compare ratings, experience and prices.`;
  return {
    title,
    description,
    alternates: { canonical: domainPath(domain.name) },
    openGraph: { title, description, url: domainPath(domain.name) },
  };
}

export default async function ExpertsByFieldPage({
  params,
}: Readonly<{ params: Params }>) {
  const { domain: slug } = await params;
  const found = await loadDomain(slug);
  if (!found) notFound();
  const { domain, count, domains, subdomains } = found;
  const detail = fieldDetail(domain.name);
  // The field's real subdomains open a filtered directory; the curated topics are a fallback search.
  const topics =
    subdomains.length > 0
      ? subdomains.map((subdomain) => ({
          label: subdomain.name,
          href: `/explore/experts?domain=${domain.id}&subdomain=${subdomain.id}`,
        }))
      : (detail?.topics ?? []).map((topic) => ({
          label: topic,
          href: `/explore/experts?domain=${domain.id}&search=${encodeURIComponent(topic)}`,
        }));
  const experts = await getTopExpertsInDomain(domain.id, 12);
  const others = domains.filter((d) => d.id !== domain.id);
  const noun = count === 1 ? "expert" : "experts";
  const countSentence =
    count > 0
      ? `${count} vetted ${noun} in ${domain.name.toLowerCase()}. `
      : "";

  const itemList = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${domain.name} experts`,
    url: `${BASE_URL}${domainPath(domain.name)}`,
    mainEntity: {
      "@type": "ItemList",
      itemListElement: experts.map((expert, index) => ({
        "@type": "ListItem",
        position: index + 1,
        url: `${BASE_URL}/explore/experts/${expert.id}`,
        name: expert.user.name ?? undefined,
      })),
    },
  };

  return (
    <div className="w-full">
      <JsonLd data={itemList} />
      <div className="border-b border-border bg-card px-4 py-4 md:px-8 lg:px-12">
        <PublicBreadcrumb
          items={[
            { label: "Experts", href: "/explore/experts" },
            { label: domain.name },
          ]}
        />
      </div>

      <section className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 py-10 space-y-8">
        <header
          className={cn(
            "grid gap-8 overflow-hidden rounded-3xl bg-gradient-to-br p-7 md:p-10 lg:grid-cols-2 lg:items-center",
            detail?.tint ?? "from-zinc-100 to-zinc-50",
          )}
        >
          <div className="space-y-4">
            <h1 className="text-3xl md:text-5xl font-bold tracking-tight text-zinc-900">
              {domain.name} experts and mentors
            </h1>
            {detail && (
              <p className="text-lg text-zinc-700">{detail.tagline}</p>
            )}
            <p className="text-zinc-600">
              {countSentence}
              Compare ratings, experience and prices, then book a session.
            </p>
            <Button asChild size="lg">
              <Link href={`/explore/experts?domain=${domain.id}`}>
                Filter all {domain.name.toLowerCase()} experts
              </Link>
            </Button>
          </div>
          {detail?.photo && (
            <div className="relative h-56 overflow-hidden rounded-2xl shadow-elevation-2 md:h-72">
              <Image
                src={detail.photo.src}
                alt={detail.photo.alt}
                fill
                priority
                sizes="(min-width: 1024px) 45vw, 100vw"
                className="object-cover"
              />
            </div>
          )}
        </header>

        {topics.length > 0 && (
          <nav
            aria-label={`Popular topics in ${domain.name}`}
            className="space-y-3"
          >
            <h2 className="text-lg font-semibold">Popular topics</h2>
            <ul className="flex flex-wrap gap-2">
              {topics.map((topic) => (
                <li key={topic.label}>
                  <Link
                    href={topic.href}
                    className="inline-flex rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-foreground/30 hover:bg-muted"
                  >
                    {topic.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}

        <h2 className="text-lg font-semibold">
          Top {domain.name.toLowerCase()} experts
        </h2>
        {experts.length > 0 ? (
          <div className="flex flex-wrap gap-4">
            {experts.map((expert) => (
              <ExpertMiniCard key={expert.id} expert={expert} />
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground">
            No listed experts in this field yet.
          </p>
        )}

        {others.length > 0 && (
          <nav aria-label="Other fields" className="space-y-2">
            <h2 className="text-sm font-semibold">Other fields</h2>
            <div className="flex flex-wrap gap-2">
              {others.map((other) => (
                <Link
                  key={other.id}
                  href={domainPath(other.name)}
                  className="text-xs px-3 py-1.5 rounded-full bg-muted text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                >
                  {other.name}
                </Link>
              ))}
            </div>
          </nav>
        )}
      </section>
    </div>
  );
}

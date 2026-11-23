import Image from "next/image";
import Link from "next/link";

import { fieldDetail } from "@/components/home/fields";
import { domainPath } from "@/lib/explore/domain-slug";
import { cn } from "@/utils/tailwind";

interface FieldCount {
  id: string;
  name: string;
  consultantCount: number;
}

/** Photo cards for every field with verified experts, each opening its category page. */
export function FieldCardsRow({ fields }: Readonly<{ fields: FieldCount[] }>) {
  const listed = fields
    .filter((field) => field.consultantCount > 0)
    .sort((a, b) => b.consultantCount - a.consultantCount);
  if (listed.length === 0) return null;

  return (
    <nav
      aria-label="Browse by field"
      className="mx-auto max-w-[1600px] px-4 pt-10 md:px-8 lg:px-12"
    >
      <h2 className="mb-4 text-lg font-semibold text-foreground">
        Browse by field
      </h2>
      <ul className="-mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-2 md:mx-0 md:grid md:grid-cols-[repeat(auto-fill,minmax(200px,1fr))] md:overflow-visible md:px-0">
        {listed.map((field) => {
          const photo = fieldDetail(field.name)?.photo;
          return (
            <li key={field.id} className="w-56 shrink-0 snap-start md:w-auto">
              <Link
                href={domainPath(field.name)}
                className={cn(
                  "group relative isolate flex h-32 flex-col justify-end overflow-hidden rounded-2xl p-4 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  !photo && "bg-zinc-900",
                )}
              >
                {photo && (
                  <Image
                    src={photo.src}
                    alt=""
                    fill
                    sizes="(min-width: 768px) 220px, 224px"
                    className="-z-10 object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                )}
                <div
                  aria-hidden="true"
                  className="absolute inset-0 -z-10 bg-gradient-to-t from-black/85 via-black/40 to-black/10"
                />
                <span className="font-semibold">{field.name}</span>
                <span className="text-sm text-zinc-300">
                  {field.consultantCount === 1
                    ? "1 expert"
                    : `${field.consultantCount} experts`}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

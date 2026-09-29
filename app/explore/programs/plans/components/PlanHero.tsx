import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

export function PlanHero({
  title,
  image,
  children,
}: Readonly<{ title: string; image: string; children: ReactNode }>) {
  return (
    <div className="explore-container pt-6 md:pt-8">
      <Link
        href="/explore/programs"
        className="mb-6 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to programs
      </Link>
      <header className="explore-plan-header grid items-center gap-6 md:grid-cols-[1.4fr_1fr]">
        <div className="min-w-0">
          {children}
          <h1 className="mt-4 text-fluid-4xl font-semibold leading-tight tracking-tight break-words">
            {title}
          </h1>
        </div>
        <div className="relative aspect-[16/10] overflow-hidden rounded-2xl">
          <Image
            src={image}
            alt=""
            fill
            priority
            sizes="(max-width: 768px) 90vw, 450px"
            className="object-cover"
          />
        </div>
      </header>
    </div>
  );
}

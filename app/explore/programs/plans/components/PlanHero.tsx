import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

export function PlanHero({
  title,
  image,
  badge,
  children,
}: Readonly<{
  title: string;
  image: string;
  badge: ReactNode;
  children: ReactNode;
}>) {
  return (
    <div className="relative h-[350px] md:h-[400px] w-full overflow-hidden">
      <Image
        src={image}
        alt=""
        fill
        priority
        sizes="100vw"
        className="object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/60 to-transparent" />
      <div className="absolute top-0 left-0 right-0 z-10">
        <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 py-6">
          <Link
            href="/explore/programs"
            className="inline-flex items-center gap-2 text-sm text-white/80 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" /> Back to Programs
          </Link>
        </div>
      </div>
      <div className="absolute bottom-0 left-0 right-0 z-10">
        <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 pb-8">
          {badge}
          <h1 className="text-fluid-4xl tracking-tight font-bold text-white mb-2">
            {title}
          </h1>
          {children}
        </div>
      </div>
    </div>
  );
}

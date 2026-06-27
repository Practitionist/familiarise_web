import { Reveal } from "@/components/ui/reveal";
import { COMPANY_LOGOS } from "./data";

export function TrustedBySection() {
  return (
    <section className="py-16 bg-zinc-950 border-b border-zinc-900">
      <div className="container mx-auto px-4 md:px-6">
        <Reveal className="text-center text-zinc-500 text-sm mb-8">
          Our experts have worked at leading companies
        </Reveal>
        <div className="flex flex-wrap items-center justify-center gap-8 md:gap-16">
          {COMPANY_LOGOS.map((company, i) => (
            <Reveal
              key={company}
              className="text-zinc-600 font-semibold text-lg md:text-xl hover:text-zinc-400 transition-colors cursor-default"
              delay={i * 0.05}
            >
              {company}
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

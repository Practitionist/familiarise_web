import { Reveal } from "@/components/ui/reveal";
import { TRUST_BADGES } from "./data";

export function TrustBadgesSection() {
  return (
    <section className="py-16 bg-zinc-950 border-y border-zinc-900">
      <div className="container mx-auto px-4 md:px-6">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-8">
          {TRUST_BADGES.map((badge, index) => (
            <Reveal
              key={badge.label}
              delay={index * 0.1}
              className="text-center"
            >
              <div className="w-12 h-12 rounded-full bg-zinc-800 flex items-center justify-center mx-auto mb-3">
                <badge.icon className="w-6 h-6 text-zinc-300" />
              </div>
              <h4 className="font-semibold text-white mb-1">{badge.label}</h4>
              <p className="text-sm text-zinc-500">{badge.description}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

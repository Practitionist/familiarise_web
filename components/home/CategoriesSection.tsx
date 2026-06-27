import { ChevronRight, LucideIcon } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Reveal } from "@/components/ui/reveal";
import { CATEGORIES } from "./data";

function CategoryCard({
  category,
  index,
}: {
  category: { icon: LucideIcon; name: string; count: string; color: string };
  index: number;
}) {
  const Icon = category.icon;

  return (
    <Reveal delay={index * 0.05}>
      <Link href={`/explore/experts?category=${category.name.toLowerCase()}`}>
        <Card className="group cursor-pointer border border-border bg-card hover:border-foreground/40 transition-all duration-300 hover:-translate-y-1 hover:shadow-elevation-2">
          <CardContent className="p-6 flex items-center gap-4">
            <div
              className={`w-12 h-12 rounded-xl ${category.color} flex items-center justify-center group-hover:scale-110 transition-transform`}
            >
              <Icon className="w-6 h-6 text-white" />
            </div>
            <div className="min-w-0">
              <h4 className="font-semibold text-foreground truncate">
                {category.name}
              </h4>
              <p className="text-sm text-muted-foreground truncate">
                {category.count}
              </p>
            </div>
            <ChevronRight className="w-5 h-5 text-muted-foreground ml-auto group-hover:translate-x-1 transition-transform shrink-0" />
          </CardContent>
        </Card>
      </Link>
    </Reveal>
  );
}

export function CategoriesSection() {
  return (
    <section className="py-20 md:py-32 bg-gradient-to-b from-white to-zinc-50 relative overflow-hidden">
      <div className="absolute inset-0 grid-pattern-dark opacity-30" />

      <div className="container mx-auto px-4 md:px-6 relative z-10">
        <Reveal className="text-center mb-12">
          <Badge
            variant="secondary"
            className="mb-4 bg-secondary text-secondary-foreground hover:bg-secondary border-0"
          >
            Categories
          </Badge>
          <h2 className="text-fluid-4xl font-bold text-foreground mb-4 tracking-tight">
            Browse by <span className="text-muted-foreground">expertise</span>
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Find experts in your field and start learning from the best
          </p>
        </Reveal>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {CATEGORIES.map((category, index) => (
            <CategoryCard
              key={category.name}
              category={category}
              index={index}
            />
          ))}
        </div>

        <Reveal className="text-center mt-10" delay={0.3}>
          <Link href="/explore/experts">
            <Button
              variant="outline"
              size="lg"
              className="border-border hover:bg-muted"
            >
              View All Categories
              <ChevronRight className="ml-2 w-4 h-4" />
            </Button>
          </Link>
        </Reveal>
      </div>
    </section>
  );
}

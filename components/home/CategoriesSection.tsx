"use client";

import { memo } from "react";
import { motion } from "framer-motion";
import { ChevronRight, LucideIcon } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CATEGORIES } from "./data";

const CategoryCard = memo(function CategoryCard({
  category,
  index,
}: {
  category: { icon: LucideIcon; name: string; count: string; color: string };
  index: number;
}) {
  const Icon = category.icon;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      whileInView={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4, delay: index * 0.05 }}
      viewport={{ once: true }}
    >
      <Link href={`/explore/experts?category=${category.name.toLowerCase()}`}>
        <Card className="group cursor-pointer border border-zinc-200 bg-white hover:border-zinc-400 transition-all duration-300 hover:-translate-y-1 hover:shadow-lg">
          <CardContent className="p-6 flex items-center gap-4">
            <div
              className={`w-12 h-12 rounded-xl ${category.color} flex items-center justify-center group-hover:scale-110 transition-transform`}
            >
              <Icon className="w-6 h-6 text-white" />
            </div>
            <div>
              <h4 className="font-semibold text-zinc-900">{category.name}</h4>
              <p className="text-sm text-zinc-500">{category.count}</p>
            </div>
            <ChevronRight className="w-5 h-5 text-zinc-400 ml-auto group-hover:translate-x-1 transition-transform" />
          </CardContent>
        </Card>
      </Link>
    </motion.div>
  );
});

export function CategoriesSection() {
  return (
    <section className="py-20 md:py-32 bg-gradient-to-b from-white to-zinc-50 relative overflow-hidden">
      <div className="absolute inset-0 grid-pattern-dark opacity-30" />

      <div className="container mx-auto px-4 md:px-6 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          viewport={{ once: true }}
          className="text-center mb-12"
        >
          <Badge
            variant="secondary"
            className="mb-4 bg-zinc-100 text-zinc-700 hover:bg-zinc-100 border-0"
          >
            Categories
          </Badge>
          <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold text-zinc-900 mb-4">
            Browse by <span className="text-zinc-500">expertise</span>
          </h2>
          <p className="text-lg text-zinc-600 max-w-2xl mx-auto">
            Find experts in your field and start learning from the best
          </p>
        </motion.div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {CATEGORIES.map((category, index) => (
            <CategoryCard
              key={category.name}
              category={category}
              index={index}
            />
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.3 }}
          viewport={{ once: true }}
          className="text-center mt-10"
        >
          <Link href="/explore/experts">
            <Button
              variant="outline"
              size="lg"
              className="border-zinc-300 hover:bg-zinc-100"
            >
              View All Categories
              <ChevronRight className="ml-2 w-4 h-4" />
            </Button>
          </Link>
        </motion.div>
      </div>
    </section>
  );
}

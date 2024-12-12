"use client";

import { Card, CardHeader, CardContent } from "@/components/ui/card";
import Link from "next/link";

export function FeaturedExperts() {
  return (
    <section className="w-full py-12 md:py-24 lg:py-32">
      <div className="space-y-12 px-4 md:px-6">
        <div className="flex flex-col items-center justify-center space-y-4 text-center">
          <div className="space-y-2">
            <div className="inline-block rounded-lg bg-black px-3 py-1 text-sm text-white">
              Featured Experts
            </div>
            <h2 className="text-3xl font-bold tracking-tighter sm:text-5xl">
              Top Consultants
            </h2>
            <p className="max-w-[900px] text-gray-500 md:text-xl/relaxed lg:text-base/relaxed xl:text-xl/relaxed dark:text-gray-400">
              Discover the best of the best. Our top consultants are ready to
              help you with your business needs.
            </p>
          </div>
        </div>
        <div className="mx-auto grid items-start gap-8 sm:max-w-4xl sm:grid-cols-2 md:gap-12 lg:max-w-5xl lg:grid-cols-3">
          <Card>
            <CardHeader>
              <h3 className="text-lg font-bold">John Doe</h3>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Get help with your business strategy from a top consultant.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <h3 className="text-lg font-bold">Eliot</h3>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Get help with your product design from a top consultant.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <h3 className="text-lg font-bold">Macmillan</h3>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Get help with your marketing strategy from a top consultant.
              </p>
            </CardContent>
          </Card>
        </div>
        <div className="flex justify-center space-x-4">
          <Link
            className="inline-flex h-10 items-center justify-center rounded-md bg-slate-200 px-8 text-sm font-medium text-gray-900 shadow transition-colors hover:bg-slate-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-950 disabled:pointer-events-none disabled:opacity-50 dark:bg-slate-200 dark:text-gray-900 dark:hover:bg-slate-300 dark:focus-visible:ring-gray-300"
            href="#"
          >
            View All Experts
          </Link>
        </div>
      </div>
    </section>
  );
}

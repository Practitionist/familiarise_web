"use client";

import { Avatar } from "@/components/ui/avatar";

export function Testimonials() {
  return (
    <section className="w-full py-12 md:py-24 lg:py-32 bg-black dark:bg-black">
      <div className="grid items-center justify-center gap-4 px-4 text-center md:px-6">
        <div className="space-y-3">
          <h2 className="text-3xl font-bold tracking-tighter md:text-4xl/tight text-white">
            <span className="bg-clip-text text-transparent bg-gradient-to-r from-gray-700 to-white">
              What Our Customers Say
            </span>
          </h2>
          <p className="mx-auto max-w-[600px] text-gray-500 md:text-xl/relaxed lg:text-base/relaxed xl:text-xl/relaxed dark:text-gray-400">
            Hear from our valued customers about their experience with our
            experts.
          </p>
        </div>
        <div className="mx-auto w-full max-w-sm space-y-2">
          <Avatar className="w-12 h-12" />
          <p className="text-sm text-gray-500 dark:text-gray-400">
            &ldquo;The expert I consulted with was incredibly knowledgeable and
            helped me solve my business challenges quickly.&ldquo;
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            - Satisfied Client
          </p>
        </div>
      </div>
    </section>
  );
}

import Link from "next/link";
import { ImageType } from "@/hooks/useImages";
import { renderImage } from "@/lib/image";

export default function BestExpertsSection({ images }: { images: ImageType[] }) {
  return (
    <section className="w-full border-y pt-6 md:pt-12 lg:pt-16 xl:pt-20">
      <div className="px-4 md:px-6 space-y-10 xl:space-y-16">
        <div className="grid max-w-[1300px] mx-auto gap-4 px-4 sm:px-6 md:px-10 md:grid-cols-2 md:gap-16">
          <div>
            <h1 className="lg:leading-tighter text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl xl:text-[3.4rem] 2xl:text-[3.75rem]">
              The Best Experts in the World
            </h1>
          </div>
          <div className="flex flex-col items-start space-y-4">
            <p className="mx-auto max-w-[700px] text-gray-500 md:text-xl dark:text-gray-400">
              Explore our wide range of consultants and find the right one
              for your business.
            </p>
            <div className="space-x-4">
              <Link
                className="inline-flex h-9 items-center justify-center rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-gray-50 shadow transition-colors hover:bg-gray-900/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-950 disabled:pointer-events-none disabled:opacity-50 dark:bg-gray-50 dark:text-gray-900 dark:hover:bg-gray-50/90 dark:focus-visible:ring-gray-300"
                href="#"
              >
                Get Started
              </Link>
            </div>
          </div>
        </div>
        <div className="w-full max-w-[1600px] mx-auto overflow-hidden">
          {renderImage(images, 3, "/placeholder.svg", 1300, 867)}
        </div>
      </div>
    </section>
  );
}
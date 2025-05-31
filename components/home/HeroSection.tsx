import Link from "next/link";
import { ImageType } from "@/hooks/useImages";
import { renderImage } from "@/utils/image";

export default function HeroSection({ images }: { images: ImageType[] }) {
  return (
    <section className="relative py-12 md:py-24 lg:py-32 xl:py-40 overflow-hidden">
      {/* Blurry background colors */}
      <div className="absolute inset-0 overflow-hidden">
        {/* Top left */}
        <div className="absolute -left-20 -top-20 w-96 h-96 bg-blue-400 rounded-full mix-blend-multiply filter blur-3xl opacity-40 animate-blob"></div>

        {/* Top right */}
        <div className="absolute -right-20 -top-20 w-96 h-96 bg-green-400 rounded-full mix-blend-multiply filter blur-3xl opacity-40 animate-blob animation-delay-2000"></div>

        {/* Middle left */}
        <div className="absolute -left-32 top-1/3 w-96 h-96 bg-purple-400 rounded-full mix-blend-multiply filter blur-3xl opacity-35 animate-blob animation-delay-4000"></div>

        {/* Middle right */}
        <div className="absolute -right-32 top-1/2 w-96 h-96 bg-pink-400 rounded-full mix-blend-multiply filter blur-3xl opacity-35 animate-blob animation-delay-3000"></div>

        {/* Bottom left */}
        <div className="absolute left-1/4 -bottom-20 w-96 h-96 bg-yellow-400 rounded-full mix-blend-multiply filter blur-3xl opacity-40 animate-blob animation-delay-5000"></div>

        {/* Bottom right */}
        <div className="absolute right-1/4 -bottom-20 w-96 h-96 bg-cyan-400 rounded-full mix-blend-multiply filter blur-3xl opacity-40 animate-blob animation-delay-6000"></div>
      </div>

      {/* Simple gradient transition to next section */}
      <div className="absolute bottom-0 left-0 w-full h-24 bg-gradient-to-t from-white to-transparent"></div>

      <div className="container relative z-10 mx-auto px-4 md:px-6">
        <div className="flex flex-col items-center space-y-6 text-center mb-10">
          <div className="flex space-x-2 mb-2">
            <div className="inline-flex items-center rounded-full px-3 py-1 text-sm bg-amber-100 text-amber-800 border border-amber-200">
              <span className="mr-1">🏆</span> Project of the week
            </div>
            <div className="inline-flex items-center rounded-full px-3 py-1 text-sm bg-rose-100 text-rose-800 border border-rose-200">
              <span className="mr-1">🥇</span> #2 Product of the Day
            </div>
          </div>

          <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tighter text-gray-900">
            Elevate Your Career with Familiarise
          </h1>
          <p className="max-w-[700px] text-xl md:text-2xl text-gray-800">
            A platform where experts share their advice through 1-1 sessions,
            classes, webinars, and conferences.
          </p>
          <div className="flex space-x-4">
            <Link
              className="inline-flex h-12 items-center justify-center rounded-md bg-gray-900 px-6 py-3 text-sm font-medium text-white shadow transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950"
              href="/explore/experts"
            >
              <span className="mr-2">Get Started</span>
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M6 12L10 8L6 4"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Link>
          </div>
        </div>

        {/* Dashboard image in a container */}
        <div className="relative max-w-5xl mx-auto rounded-xl overflow-hidden shadow-2xl border border-gray-200 bg-white">
          <div className="relative w-full aspect-[16/9]">
            {renderImage(images, 0, "/placeholder.svg", 1920, 1080)}
          </div>
        </div>
      </div>
    </section>
  );
}

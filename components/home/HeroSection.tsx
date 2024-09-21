import Link from "next/link";
import { ImageType } from "@/hooks/useImages";
import { renderImage } from "@/lib/image";

export default function HeroSection({ images }: { images: ImageType[] }) {
  return (
    <section
      className="h-screen py-12 md:py-24 lg:py-32 xl:py-40 bg-gray-100 flex items-center"
      style={{
        backgroundImage: `url(${renderImage(images, 0, "/placeholder.svg", 1920, 1080).props.src})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundPositionY: "15%",
      }}
    >
      <div className="container mx-auto px-4 md:px-6">
        <div className="flex flex-col items-center space-y-6 text-center">
          <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tighter text-gray-900">
            Elevate Your Career with ConsultX
          </h1>
          <p className="max-w-[700px] text-xl md:text-2xl text-gray-800 italic">
            <q>
              A platform where experts share their advice through 1-1
              sessions, classes, webinars, and conferences.
            </q>
          </p>
          <div className="flex space-x-4">
            <Link
              className="inline-flex h-12 items-center justify-center rounded-md bg-gray-900 px-6 py-3 text-sm font-medium text-white shadow transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950"
              href="#"
            >
              Book an Expert Session
            </Link>
            <Link
              className="inline-flex h-12 items-center justify-center rounded-md border border-black bg-gray-200 px-6 py-3 text-sm font-medium text-black shadow transition-colors hover:bg-gray-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black"
              href="#"
            >
              Learn More
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
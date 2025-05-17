import Link from "next/link";
import { ImageType } from "@/hooks/useImages";
import { renderImage } from "@/utils/image";

export default function TransformCareerSection({
  images,
}: {
  images: ImageType[];
}) {
  return (
    <section className="w-full py-16 md:py-24 lg:py-32">
      <div className="container mx-auto px-4 md:px-6">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className="flex flex-col justify-center space-y-6">
            <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tighter">
              Transform Your Career with Expert Guidance
            </h2>
            <ul className="space-y-4 text-lg text-gray-600 md:text-xl">
              <li>
                <span className="font-semibold">✓ Accelerate Your Growth:</span>{" "}
                Gain years of industry insights in just hours through our 1-1
                sessions.
              </li>
              <li>
                <span className="font-semibold">✓ Expand Your Network:</span>{" "}
                Connect with industry leaders and peers in our exclusive classes
                and webinars.
              </li>
              <li>
                <span className="font-semibold">
                  ✓ Stay Ahead of the Curve:
                </span>{" "}
                Access cutting-edge knowledge and trends through our
                conferences.
              </li>
            </ul>
            <Link
              className="inline-flex w-full sm:w-auto items-center justify-center rounded-md bg-gray-900 px-6 py-3 text-sm font-medium text-white shadow transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950"
              href="#"
            >
              Start Your Journey
            </Link>
          </div>
          <div className="flex justify-center">
            {renderImage(images, 1, "/placeholder.svg", 550, 310)}
          </div>
        </div>
      </div>
    </section>
  );
}

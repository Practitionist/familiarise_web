"use client";
import Image from "next/image";
/**
 * v0 by Vercel.
 * @see https://v0.dev/t/AfXYpLG
 */
import Link from "next/link";

export default function Blog() {
  return (
    <section className="w-full xl:pt-32 lg:pt-24 md:pt-20 pt-16 bg-black min-h-screen">
      {/* Dark background effect */}
      <div className="absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute inset-0 bg-black" />
        <div className="absolute top-0 left-1/4 h-[600px] w-[600px] rounded-full bg-gray-500/10 blur-3xl" />
        <div className="absolute top-1/3 right-1/4 h-[500px] w-[500px] rounded-full bg-gray-700/20 blur-3xl" />
      </div>

      {/* Page Hero */}
      <div className="container mx-auto px-4 md:px-6 pt-12 pb-16 relative z-10">
        <div className="text-center max-w-4xl mx-auto">
          <h1 className="text-5xl sm:text-6xl md:text-7xl font-bold tracking-tight bg-gradient-to-r from-gray-300 via-gray-100 to-gray-400 bg-clip-text text-transparent mb-6">
            Blog & Insights
          </h1>
          <p className="text-xl text-gray-400 leading-relaxed">
            Expert insights, industry trends, and career guidance from top consultants
          </p>
        </div>
      </div>

      <main className="w-full px-4 md:px-8 lg:px-16 py-8 relative z-10">
        <section className="mb-16 max-w-7xl mx-auto">
          <h2 className="text-4xl sm:text-5xl font-bold mb-8 bg-gradient-to-r from-gray-300 via-gray-100 to-gray-400 bg-clip-text text-transparent">Top Story</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 bg-gradient-to-br from-gray-900/80 to-gray-800/60 border border-gray-800/50 rounded-3xl p-8 hover:border-gray-600/50 transition-all duration-500 backdrop-blur-sm">
            <div>
              <Image
                alt="Top Story Image"
                className="w-full h-full object-cover object-center rounded-2xl border border-gray-700/50"
                height="400"
                src="/placeholder.svg"
                style={{
                  aspectRatio: "600/400",
                  objectFit: "cover",
                }}
                width="600"
              />
            </div>
            <div className="flex flex-col justify-center">
              <h3 className="text-3xl font-bold mb-4 text-gray-100">Top Story Headline</h3>
              <p className="text-gray-400 text-lg leading-relaxed">
                This is a brief summary of the top story. Click the link to read
                more.
              </p>
              <Link className="inline-flex items-center text-gray-300 hover:text-white mt-6 font-medium transition-colors duration-300" href="#">
                Read More →
              </Link>
            </div>
          </div>
        </section>
        <section className="mb-16">
          <h2 className="text-4xl sm:text-5xl font-bold mb-8 bg-gradient-to-r from-gray-300 via-gray-100 to-gray-400 bg-clip-text text-transparent">Politics</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div>
              <Image
                alt="Politics Story Image"
                className="w-full h-64 object-cover object-center rounded-2xl border border-gray-700/50"
                height="400"
                src="/placeholder.svg"
                style={{
                  aspectRatio: "600/400",
                  objectFit: "cover",
                }}
                width="600"
              />
              <h3 className="text-2xl font-bold mb-3 mt-4 text-gray-100">
                Politics Story Headline
              </h3>
              <p className="text-gray-400 leading-relaxed">
                This is a brief summary of the politics story. Click the link to
                read more.
              </p>
              <Link className="inline-flex items-center text-gray-300 hover:text-white mt-4 font-medium transition-colors duration-300" href="#">
                Read More →
              </Link>
            </div>
            <div>
              <Image
                alt="Politics Story Image"
                className="w-full h-64 object-cover object-center rounded-2xl border border-gray-700/50"
                height="400"
                src="/placeholder.svg"
                style={{
                  aspectRatio: "600/400",
                  objectFit: "cover",
                }}
                width="600"
              />
              <h3 className="text-2xl font-bold mb-3 mt-4 text-gray-100">
                Politics Story Headline
              </h3>
              <p className="text-gray-400 leading-relaxed">
                This is a brief summary of the politics story. Click the link to
                read more.
              </p>
              <Link className="inline-flex items-center text-gray-300 hover:text-white mt-4 font-medium transition-colors duration-300" href="#">
                Read More →
              </Link>
            </div>
            <div>
              <Image
                alt="Politics Story Image"
                className="w-full h-64 object-cover object-center rounded-2xl border border-gray-700/50"
                height="400"
                src="/placeholder.svg"
                style={{
                  aspectRatio: "600/400",
                  objectFit: "cover",
                }}
                width="600"
              />
              <h3 className="text-2xl font-bold mb-3 mt-4 text-gray-100">
                Politics Story Headline
              </h3>
              <p className="text-gray-400 leading-relaxed">
                This is a brief summary of the politics story. Click the link to
                read more.
              </p>
              <Link className="inline-flex items-center text-gray-300 hover:text-white mt-4 font-medium transition-colors duration-300" href="#">
                Read More →
              </Link>
            </div>
          </div>
        </section>
        <section className="mb-16">
          <h2 className="text-4xl sm:text-5xl font-bold mb-8 bg-gradient-to-r from-gray-300 via-gray-100 to-gray-400 bg-clip-text text-transparent">Business</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div>
              <Image
                alt="Business Story Image"
                className="w-full h-64 object-cover object-center rounded-2xl border border-gray-700/50"
                height="400"
                src="/placeholder.svg"
                style={{
                  aspectRatio: "600/400",
                  objectFit: "cover",
                }}
                width="600"
              />
              <h3 className="text-2xl font-bold mb-3 mt-4 text-gray-100">
                Business Story Headline
              </h3>
              <p className="text-gray-400 leading-relaxed">
                This is a brief summary of the business story. Click the link to
                read more.
              </p>
              <Link className="inline-flex items-center text-gray-300 hover:text-white mt-4 font-medium transition-colors duration-300" href="#">
                Read More →
              </Link>
            </div>
            <div>
              <Image
                alt="Business Story Image"
                className="w-full h-64 object-cover object-center rounded-2xl border border-gray-700/50"
                height="400"
                src="/placeholder.svg"
                style={{
                  aspectRatio: "600/400",
                  objectFit: "cover",
                }}
                width="600"
              />
              <h3 className="text-2xl font-bold mb-3 mt-4 text-gray-100">
                Business Story Headline
              </h3>
              <p className="text-gray-400 leading-relaxed">
                This is a brief summary of the business story. Click the link to
                read more.
              </p>
              <Link className="inline-flex items-center text-gray-300 hover:text-white mt-4 font-medium transition-colors duration-300" href="#">
                Read More →
              </Link>
            </div>
            <div>
              <Image
                alt="Business Story Image"
                className="w-full h-64 object-cover object-center rounded-2xl border border-gray-700/50"
                height="400"
                src="/placeholder.svg"
                style={{
                  aspectRatio: "600/400",
                  objectFit: "cover",
                }}
                width="600"
              />
              <h3 className="text-2xl font-bold mb-3 mt-4 text-gray-100">
                Business Story Headline
              </h3>
              <p className="text-gray-400 leading-relaxed">
                This is a brief summary of the business story. Click the link to
                read more.
              </p>
              <Link className="inline-flex items-center text-gray-300 hover:text-white mt-4 font-medium transition-colors duration-300" href="#">
                Read More →
              </Link>
            </div>
          </div>
        </section>
        <section className="mb-16">
          <h2 className="text-4xl sm:text-5xl font-bold mb-8 bg-gradient-to-r from-gray-300 via-gray-100 to-gray-400 bg-clip-text text-transparent">Tech</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <Image
                alt="Tech Story Image"
                className="w-full h-64 object-cover object-center rounded-2xl border border-gray-700/50"
                height="400"
                src="/placeholder.svg"
                style={{
                  aspectRatio: "600/400",
                  objectFit: "cover",
                }}
                width="600"
              />
              <h3 className="text-2xl font-bold mb-3 mt-4 text-gray-100">
                Tech Story Headline
              </h3>
              <p className="text-gray-400 leading-relaxed">
                This is a brief summary of the tech story. Click the link to
                read more.
              </p>
              <Link className="inline-flex items-center text-gray-300 hover:text-white mt-4 font-medium transition-colors duration-300" href="#">
                Read More →
              </Link>
            </div>
            <div>
              <Image
                alt="Tech Story Image"
                className="w-full h-64 object-cover object-center rounded-2xl border border-gray-700/50"
                height="400"
                src="/placeholder.svg"
                style={{
                  aspectRatio: "600/400",
                  objectFit: "cover",
                }}
                width="600"
              />
              <h3 className="text-2xl font-bold mb-3 mt-4 text-gray-100">
                Tech Story Headline
              </h3>
              <p className="text-gray-400 leading-relaxed">
                This is a brief summary of the tech story. Click the link to
                read more.
              </p>
              <Link className="inline-flex items-center text-gray-300 hover:text-white mt-4 font-medium transition-colors duration-300" href="#">
                Read More →
              </Link>
            </div>
            <div>
              <Image
                alt="Tech Story Image"
                className="w-full h-64 object-cover object-center rounded-2xl border border-gray-700/50"
                height="400"
                src="/placeholder.svg"
                style={{
                  aspectRatio: "600/400",
                  objectFit: "cover",
                }}
                width="600"
              />
              <h3 className="text-2xl font-bold mb-3 mt-4 text-gray-100">
                Tech Story Headline
              </h3>
              <p className="text-gray-400 leading-relaxed">
                This is a brief summary of the tech story. Click the link to
                read more.
              </p>
              <Link className="inline-flex items-center text-gray-300 hover:text-white mt-4 font-medium transition-colors duration-300" href="#">
                Read More →
              </Link>
            </div>
          </div>
        </section>
        <section className="mb-16">
          <h2 className="text-4xl sm:text-5xl font-bold mb-8 bg-gradient-to-r from-gray-300 via-gray-100 to-gray-400 bg-clip-text text-transparent">Culture</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <Image
                alt="Culture Story Image"
                className="w-full h-64 object-cover object-center rounded-2xl border border-gray-700/50"
                height="400"
                src="/placeholder.svg"
                style={{
                  aspectRatio: "600/400",
                  objectFit: "cover",
                }}
                width="600"
              />
              <h3 className="text-2xl font-bold mb-3 mt-4 text-gray-100">
                Culture Story Headline
              </h3>
              <p className="text-gray-400 leading-relaxed">
                This is a brief summary of the culture story. Click the link to
                read more.
              </p>
              <Link className="inline-flex items-center text-gray-300 hover:text-white mt-4 font-medium transition-colors duration-300" href="#">
                Read More →
              </Link>
            </div>
            <div>
              <Image
                alt="Culture Story Image"
                className="w-full h-64 object-cover object-center rounded-2xl border border-gray-700/50"
                height="400"
                src="/placeholder.svg"
                style={{
                  aspectRatio: "600/400",
                  objectFit: "cover",
                }}
                width="600"
              />
              <h3 className="text-2xl font-bold mb-3 mt-4 text-gray-100">
                Culture Story Headline
              </h3>
              <p className="text-gray-400 leading-relaxed">
                This is a brief summary of the culture story. Click the link to
                read more.
              </p>
              <Link className="inline-flex items-center text-gray-300 hover:text-white mt-4 font-medium transition-colors duration-300" href="#">
                Read More →
              </Link>
            </div>
            <div>
              <Image
                alt="Culture Story Image"
                className="w-full h-64 object-cover object-center rounded-2xl border border-gray-700/50"
                height="400"
                src="/placeholder.svg"
                style={{
                  aspectRatio: "600/400",
                  objectFit: "cover",
                }}
                width="600"
              />
              <h3 className="text-2xl font-bold mb-3 mt-4 text-gray-100">
                Culture Story Headline
              </h3>
              <p className="text-gray-400 leading-relaxed">
                This is a brief summary of the culture story. Click the link to
                read more.
              </p>
              <Link className="inline-flex items-center text-gray-300 hover:text-white mt-4 font-medium transition-colors duration-300" href="#">
                Read More →
              </Link>
            </div>
          </div>
        </section>
        <section className="mb-16">
          <h2 className="text-4xl sm:text-5xl font-bold mb-8 bg-gradient-to-r from-gray-300 via-gray-100 to-gray-400 bg-clip-text text-transparent">Sports</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <Image
                alt="Sports Story Image"
                className="w-full h-64 object-cover object-center rounded-2xl border border-gray-700/50"
                height="400"
                src="/placeholder.svg"
                style={{
                  aspectRatio: "600/400",
                  objectFit: "cover",
                }}
                width="600"
              />
              <h3 className="text-2xl font-bold mb-3 mt-4 text-gray-100">
                Sports Story Headline
              </h3>
              <p className="text-gray-400 leading-relaxed">
                This is a brief summary of the sports story. Click the link to
                read more.
              </p>
              <Link className="inline-flex items-center text-gray-300 hover:text-white mt-4 font-medium transition-colors duration-300" href="#">
                Read More →
              </Link>
            </div>
            <div>
              <Image
                alt="Sports Story Image"
                className="w-full h-64 object-cover object-center rounded-2xl border border-gray-700/50"
                height="400"
                src="/placeholder.svg"
                style={{
                  aspectRatio: "600/400",
                  objectFit: "cover",
                }}
                width="600"
              />
              <h3 className="text-2xl font-bold mb-3 mt-4 text-gray-100">
                Sports Story Headline
              </h3>
              <p className="text-gray-400 leading-relaxed">
                This is a brief summary of the sports story. Click the link to
                read more.
              </p>
              <Link className="inline-flex items-center text-gray-300 hover:text-white mt-4 font-medium transition-colors duration-300" href="#">
                Read More →
              </Link>
            </div>
            <div>
              <Image
                alt="Sports Story Image"
                className="w-full h-64 object-cover object-center rounded-2xl border border-gray-700/50"
                height="400"
                src="/placeholder.svg"
                style={{
                  aspectRatio: "600/400",
                  objectFit: "cover",
                }}
                width="600"
              />
              <h3 className="text-2xl font-bold mb-3 mt-4 text-gray-100">
                Sports Story Headline
              </h3>
              <p className="text-gray-400 leading-relaxed">
                This is a brief summary of the sports story. Click the link to
                read more.
              </p>
              <Link className="inline-flex items-center text-gray-300 hover:text-white mt-4 font-medium transition-colors duration-300" href="#">
                Read More →
              </Link>
            </div>
          </div>
        </section>
      </main>
    </section>
  );
}

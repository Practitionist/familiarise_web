/** @type {import('next').NextConfig} */
import bundleAnalyzer from "@next/bundle-analyzer";

const withBundleAnalyzer =
  process.env.ANALYZE === "true"
    ? bundleAnalyzer({
        enabled: true,
        openAnalyzer: true,
      })
    : (config) => config;

const nextConfig = {
  // This tells Next.js to explicitly process these packages during the build, which should resolve the module format conflict.
  transpilePackages: ["react-day-picker", "date-fns"],

  images: {
    // Enable modern image formats for better compression (50-80% smaller than JPEG/PNG)
    formats: ["image/avif", "image/webp"],
    // Cache optimized images for 60 seconds minimum
    minimumCacheTTL: 60,
    remotePatterns: [
      {
        hostname: "lh3.googleusercontent.com",
      },
      {
        hostname: "firebasestorage.googleapis.com",
      },
      {
        hostname: "*.supabase.co",
      },
      {
        hostname: "avatars.githubusercontent.com",
      },
      {
        hostname: "cloudflare-ipfs.com",
      },
      {
        hostname: "picsum.photos",
      },
      {
        hostname: "source.unsplash.com",
      },
      {
        hostname: "cdn.jsdelivr.net",
      },
    ],
  },

  // Reduce JavaScript bundle size by removing console statements in production
  compiler: {
    removeConsole: process.env.NODE_ENV === "production",
  },
};

export default withBundleAnalyzer(nextConfig);

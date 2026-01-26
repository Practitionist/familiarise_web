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

  // Prevent pg (node-postgres) and related packages from being bundled into client-side code
  // These are server-only dependencies used by @prisma/adapter-pg
  serverExternalPackages: [
    "pg",
    "@prisma/adapter-pg",
    "pg-pool",
    "pg-connection-string",
  ],

  images: {
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

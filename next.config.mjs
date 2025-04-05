/** @type {import('next').NextConfig} */
const config = {
  // This tells Next.js to explicitly process these packages during the build, which should resolve the module format conflict.
  transpilePackages: ['react-day-picker', 'date-fns'],

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
    ],
  },
};

export default config;

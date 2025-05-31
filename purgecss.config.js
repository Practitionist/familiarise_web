/**
 * PurgeCSS configuration wrapper
 * This file loads the TypeScript configuration and exports it for PurgeCSS
 */

// Use CommonJS format since PurgeCSS expects this
module.exports = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
    "./app/**/*.{js,ts,jsx,tsx}",
  ],
  css: ["./.next/static/css/**/*.css"],
  defaultExtractor: (content) => content.match(/[\w-/:]+(?<!:)/g) || [],
  safelist: {
    standard: [
      // Add classes that should never be purged
      /^bg-/,
      /^text-/,
      "html",
      "body",
      "fade-in",
      "fade-out",
      "slide-in",
      "slide-out",
      /^data-/,
      /^aria-/,
      /^swiper-/,
      /^splide-/,
      /^react-/,
      /^next-/,
    ],
    deep: [
      // Regex for classes that have variations
      /^animate-/,
      /^motion-/,
      /^transition-/,
      /^transform-/,
      /^duration-/,
      /^delay-/,
      /^ease-/,
    ],
    greedy: [
      // Regex for classes that might be used in JS
      /^group$/,
      /^group-/,
      /^hover:/,
    ],
  },
};

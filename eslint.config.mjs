import { FlatCompat } from "@eslint/eslintrc";
import pluginJs from "@eslint/js";
import pluginCypress from "eslint-plugin-cypress";
import pluginJest from "eslint-plugin-jest";
import pluginReact from "eslint-plugin-react";
import globals from "globals";
import path from "path";
import tseslint from "typescript-eslint";
import { fileURLToPath } from "url";

// mimic CommonJS variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
    baseDirectory: __dirname,
    // recommendedConfig: pluginJs.configs.recommended, // Optional: can be used if extending eslint:recommended via compat
    allConfig: pluginJs.configs.all, // Optional: can be used if extending eslint:all via compat
});

/** @type {import('eslint').Linter.Config[]} */
const eslintConfig = [
  // Ignore patterns
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "dist/**",
      "build/**",
      "out/**",
      "coverage/**",
      "public/static/**",
      "update-postman-collection.ts",
    ],
  },

  // Jest test files configuration
  {
    files: ["**/*.{test,spec}.{js,ts,jsx,tsx}", "jest.setup.ts"],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
    plugins: {
      jest: pluginJest,
    },
    rules: {
      ...pluginJest.configs.recommended.rules,
    },
  },

  // Cypress test files configuration
  {
    files: ["cypress/**/*.{js,ts,jsx,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        cy: true,
        Cypress: true,
        describe: true,
        it: true,
        expect: true,
        beforeEach: true,
        afterEach: true,
      },
    },
    plugins: {
      cypress: pluginCypress,
    },
  },

  // Base config for all JavaScript/TypeScript files
  {
    files: ["**/*.{js,mjs,cjs,ts,jsx,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        // Common Node.js globals
        require: true,
        module: true,
        exports: true,
        __dirname: true,
        __filename: true,
        process: true,
        Buffer: true,
        // React globals
        React: true,
        JSX: true,
      },
    },
  },

  // Core JavaScript rules
  pluginJs.configs.recommended,

  // TypeScript rules
  ...tseslint.configs.recommended,

  // Next.js specific configurations using FlatCompat
  // Choose the configurations you need. 
  // "next/core-web-vitals" is good for stricter checks.
  // "next/typescript" is for TypeScript-specific Next.js rules.
  // You can also just use "next" for the base Next.js rules.
  ...compat.extends("next/core-web-vitals"),
  ...compat.extends("next/typescript"),

  // React specific configuration
  {
    ...pluginReact.configs.flat.recommended,
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      // Warns when let is used where const could be used instead
      "prefer-const": "warn",

      // Warns when var is used instead of let or const
      "no-var": "warn",

      // Warn when using == and != instead of === and !==
      "no-case-declarations": "warn",

      // Warn when React props are missing type definitions
      "react/prop-types": "warn",

      // Warn when unescaped entities are used in JSX
      "react/no-unescaped-entities": "warn",

      // These rules are turned off since React 17+ doesn't require importing React
      // when using JSX, as the new JSX transform handles this automatically
      "react/jsx-uses-react": "off",
      "react/react-in-jsx-scope": "off",

      // Warn when empty object types are used (e.g. 'type Foo = {}')
      "@typescript-eslint/no-empty-object-type": "warn",

      // Warn when the 'any' type is used explicitly
      "@typescript-eslint/no-explicit-any": "warn",

      // Warn when using require() instead of ES6 imports
      "@typescript-eslint/no-require-imports": "warn",

      // Warn on unused variables, but allow ones starting with underscore
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          varsIgnorePattern: "^_", // Ignore variables starting with _
          argsIgnorePattern: "^_", // Ignore parameters starting with _
        },
      ],

      // Error on references to undefined variables
      // typeof check ensures typeof checks don't trigger the error
      "no-undef": ["error", { typeof: true }],
    },
  },
];

export default eslintConfig;

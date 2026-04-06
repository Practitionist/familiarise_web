import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginNext from "@next/eslint-plugin-next";
import pluginJest from "eslint-plugin-jest";
import pluginUnusedImports from "eslint-plugin-unused-imports";

/** @type {import('eslint').Linter.Config[]} */
export default [
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

  // Base config for all JavaScript/TypeScript files
  {
    files: ["**/*.{js,mjs,cjs,ts,jsx,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "unused-imports": pluginUnusedImports,
    },
  },

  // Core JavaScript rules
  pluginJs.configs.recommended,

  // TypeScript rules
  ...tseslint.configs.recommended,

  // React specific configuration
  {
    ...pluginReact.configs.flat.recommended,
    settings: {
      react: {
        version: "detect",
      },
    },
    plugins: {
      ...pluginReact.configs.flat.recommended.plugins,
      "react-hooks": pluginReactHooks,
      "@next/next": pluginNext,
    },
    rules: {
      // Warns when let is used where const could be used instead
      "prefer-const": "warn",

      // Warns when var is used instead of let or const
      "no-var": "warn",

      // Warn about lexical declarations in case blocks without braces
      "no-case-declarations": "warn",

      // Enforce === and !== over == and !=
      eqeqeq: "warn",

      // React hooks rules
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",

      // Disabled — TypeScript handles prop validation
      "react/prop-types": "off",

      // Disabled — React 17+ JSX transform doesn't require importing React
      "react/jsx-uses-react": "off",
      "react/react-in-jsx-scope": "off",

      // Next.js specific rules
      ...pluginNext.configs.recommended.rules,

      // Warn when empty object types are used (e.g. 'type Foo = {}')
      "@typescript-eslint/no-empty-object-type": "warn",

      // Warn when the 'any' type is used explicitly
      "@typescript-eslint/no-explicit-any": "warn",

      // Warn when using require() instead of ES6 imports
      "@typescript-eslint/no-require-imports": "warn",

      // Disable the built-in no-unused-vars rule as unused-imports will handle it
      "@typescript-eslint/no-unused-vars": "off",

      // Configure unused-imports plugin for auto-fixing
      "unused-imports/no-unused-imports": "warn",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          varsIgnorePattern: "^_", // Ignore variables starting with _
          argsIgnorePattern: "^_", // Ignore parameters starting with _
          caughtErrorsIgnorePattern: "^_", // Ignore catch clause errors starting with _
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // Seed files: allow control character regex (intentional sanitization for PostgreSQL)
  {
    files: ["prisma/seedFiles/**/*.ts"],
    rules: {
      "no-control-regex": "off",
    },
  },
];

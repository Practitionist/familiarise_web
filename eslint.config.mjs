import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import pluginReact from "eslint-plugin-react";

/** @type {import('eslint').Linter.Config[]} */
export default [
  // Ignore patterns for build artifacts and dependencies
  {
    ignores: [
      ".next/**",
      "node_modules/**", 
      "dist/**",
      "build/**",
      "out/**",
      "coverage/**",
      "public/static/**"
    ]
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
        JSX: true
      }
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
        version: "detect"
      }
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
      "@typescript-eslint/no-unused-vars": ["warn", { 
        "varsIgnorePattern": "^_", // Ignore variables starting with _
        "argsIgnorePattern": "^_"  // Ignore parameters starting with _
      }],

      // Error on references to undefined variables
      // typeof check ensures typeof checks don't trigger the error
      "no-undef": ["error", { "typeof": true }]
    }
  }
];

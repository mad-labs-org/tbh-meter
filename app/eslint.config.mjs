import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["out/**", "dist/**", "*.config.*"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooksPlugin,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      // eslint-plugin-react-hooks v7's `recommended` preset bundles the full React Compiler
      // ruleset (refs, set-state-in-effect, immutability, purity, …) — 16 rules vs the 2 in
      // v5. Pin just the two long-standing rules so a dependency bump doesn't silently change
      // our lint policy; adopting the compiler rules is a separate, deliberate change.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
    },
    settings: {
      react: { version: "detect" },
    },
  },
  {
    // Build/data scripts are Node ESM (process, console, …) — not part of `pnpm check`
    // (which lints only src/), but give them the right globals so an explicit lint pass
    // doesn't false-positive on Node globals.
    files: ["scripts/**/*.{js,mjs}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  prettierConfig,
);

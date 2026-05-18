/**
 * Minimal monorepo ESLint flat config.
 *
 * Most packages currently use TypeScript for lint-equivalent checks. This root
 * config makes packages that invoke ESLint over TypeScript sources independent
 * from any machine-global ESLint install while the public monorepo converges on
 * shared lint rules.
 */
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: [
      "**/build/**",
      "**/coverage/**",
      "**/dist/**",
      "**/node_modules/**",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      ecmaVersion: "latest",
      parser: tsParser,
      sourceType: "module",
    },
  },
];

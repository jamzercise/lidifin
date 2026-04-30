import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsxA11y from "eslint-plugin-jsx-a11y";

/** jsx-a11y recommended severities as warnings (Next already registers the plugin). */
function jsxA11yRecommendedAsWarn() {
    const raw = jsxA11y.flatConfigs.recommended.rules ?? {};
    return Object.fromEntries(
        Object.entries(raw).map(([key, value]) => {
            if (value === "error") return [key, "warn"];
            if (Array.isArray(value) && value[0] === "error") {
                return [key, ["warn", ...value.slice(1)]];
            }
            return [key, value];
        }),
    );
}

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      ...jsxA11yRecommendedAsWarn(),
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;

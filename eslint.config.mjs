// ESLint (flat config) з правилами, що потребують типів: головне — no-floating-promises.
// Чому на сервері це критично: необроблений rejected Promise у обробнику
// запиту або таймері завалює процес (unhandledRejection) або мовчки губить помилку.
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.mjs",
      "e2e/.logs/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["vitest.config.ts", "playwright.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        // async-обробники подій (addEventListener) — звичайна практика;
        // перевіряємо лише помилкове використання Promise в умовах.
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/only-throw-error": "error",
    },
  },
);

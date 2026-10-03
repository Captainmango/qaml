import { defineConfig } from "vitest/config";

// Exists solely to make vitest resolve the `@/*` alias from tsconfig.json.
export default defineConfig({
  resolve: { tsconfigPaths: true },
});

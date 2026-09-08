import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  // The pricing helpers under test live in the web workspace and import the shared
  // money formatter by package name. Only that module is needed, and it depends on
  // nothing but `Intl` — so it is mapped directly rather than pulling the whole
  // component library (and its React/Tailwind deps) into a node-environment run.
  resolve: {
    alias: {
      "@heirs/ui": path.resolve(__dirname, "web/packages/ui/src/lib/currency.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Deterministic unit/integration tests; no watch in CI.
    watch: false,
    // Required env vars have no defaults (no credentials baked into source), and
    // tests don't load a .env — supply harmless placeholders so config/env parses.
    env: {
      ADMIN_BOOTSTRAP_EMAIL: "test-owner@example.com",
      ADMIN_BOOTSTRAP_PASSWORD: "test-password-123",
      // Redis and Postgres are mocked in tests; these just satisfy env validation.
      REDIS_URL: "redis://localhost:6379",
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/heirs_ocr_test",
    },
  },
});

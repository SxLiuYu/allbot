import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

const config = createScopedVitestConfig(["src/security/**/*.test.ts"], {
  dir: "src",
  env: process.env,
  name: "unit-security",
  passWithNoTests: true,
});

export default config;

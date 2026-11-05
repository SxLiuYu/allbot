import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.ALLBOT_STATE_DIR && !process.env.ALLBOT_CONFIG_PATH) {
  const tempStateDir = mkdtempSync(join(tmpdir(), "allbot-vitest-"));
  process.env.ALLBOT_STATE_DIR = tempStateDir;
}

import os from "node:os";
import path from "node:path";

/** Resolve the AllBot state directory (mirrors core logic in src/infra). */
export function resolveStateDir(): string {
  return process.env.ALLBOT_STATE_DIR?.trim() || path.join(os.homedir(), ".allbot");
}

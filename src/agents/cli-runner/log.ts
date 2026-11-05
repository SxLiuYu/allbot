import { createSubsystemLogger } from "../../logging/subsystem.js";

export const cliBackendLog = createSubsystemLogger("agent/cli-backend");
export const CLI_BACKEND_LOG_OUTPUT_ENV = "ALLBOT_CLI_BACKEND_LOG_OUTPUT";
export const LEGACY_CLAUDE_CLI_LOG_OUTPUT_ENV = "ALLBOT_CLAUDE_CLI_LOG_OUTPUT";

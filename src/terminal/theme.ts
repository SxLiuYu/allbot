import chalk, { Chalk } from "chalk";
import { ALLBOT_PALETTE } from "./palette.js";

const hasForceColor =
  typeof process.env.FORCE_COLOR === "string" &&
  process.env.FORCE_COLOR.trim().length > 0 &&
  process.env.FORCE_COLOR.trim() !== "0";

const baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : chalk;

const hex = (value: string) => baseChalk.hex(value);

export const theme = {
  accent: hex(ALLBOT_PALETTE.accent),
  accentBright: hex(ALLBOT_PALETTE.accentBright),
  accentDim: hex(ALLBOT_PALETTE.accentDim),
  info: hex(ALLBOT_PALETTE.info),
  success: hex(ALLBOT_PALETTE.success),
  warn: hex(ALLBOT_PALETTE.warn),
  error: hex(ALLBOT_PALETTE.error),
  muted: hex(ALLBOT_PALETTE.muted),
  heading: baseChalk.bold.hex(ALLBOT_PALETTE.accent),
  command: hex(ALLBOT_PALETTE.accentBright),
  option: hex(ALLBOT_PALETTE.warn),
} as const;

export const isRich = () => Boolean(baseChalk.level > 0);

export const colorize = (rich: boolean, color: (value: string) => string, value: string) =>
  rich ? color(value) : value;

// AllBot cognitive palette for CLI/UI theming.
// Blue-purple accent reflecting the cognitive AI identity.
export const ALLBOT_PALETTE = {
  accent: "#6C5CE7",
  accentBright: "#A29BFE",
  accentDim: "#4834D4",
  info: "#74B9FF",
  success: "#2FBF71",
  warn: "#FFB020",
  error: "#E23D2D",
  muted: "#8B8FA3",
} as const;

/** @deprecated Use ALLBOT_PALETTE instead. */
export const LOBSTER_PALETTE = ALLBOT_PALETTE;

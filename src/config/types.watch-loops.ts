/** A low-cost watcher. No model call happens unless the URL content changes. */
export type WatchLoopConfig = {
  id: string;
  label?: string;
  url: string;
  /** Poll interval in ms. Default: 15 minutes, minimum 1 minute. */
  intervalMs?: number;
  /** Router session to wake. Default: agent:main:main. */
  sessionKey?: string;
  /** Optional instruction appended to the wake event. */
  instruction?: string;
};

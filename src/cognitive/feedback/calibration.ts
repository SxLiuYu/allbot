import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { CalibrationRecord, InsightRecord, PersonaTree } from "../types.js";

const log = createSubsystemLogger("cognitive/feedback-calibration");

// ── Constants ─────────────────────────────────────────────────────────

const MIN_RECORDS_FOR_RELIABLE = 10;
export const MAX_CALIBRATION_RECORDS = 50;
/** Fallback prediction when a delivered insight carries no usable gate snapshot. */
export const DEFAULT_PREDICTED_PACCEPT = 0.5;
const SLOPE_MIN = 0.3;
const SLOPE_MAX = 2.0;

// ── Pure functions ────────────────────────────────────────────────────

/** Outcome types that count as "actual positive" for calibration. */
const POSITIVE_OUTCOMES: ReadonlySet<CalibrationRecord["actualOutcome"]> = new Set([
  "positive",
  "engaged",
]);

/**
 * Create a calibration record. Pure function — builds the object without I/O.
 */
export function recordCalibration(
  insightId: string,
  predictedPAccept: number,
  actualOutcome: CalibrationRecord["actualOutcome"],
  nowMs?: number,
): CalibrationRecord {
  return {
    insightId,
    predictedPAccept,
    actualOutcome,
    timestamp: nowMs ?? Date.now(),
  };
}

/** Append a record, keeping only the most recent {@link MAX_CALIBRATION_RECORDS}. */
export function appendCalibration(
  history: CalibrationRecord[],
  record: CalibrationRecord,
): CalibrationRecord[] {
  return [...history, record].slice(-MAX_CALIBRATION_RECORDS);
}

/**
 * The slice of a PRISM gate decision persisted with a delivered insight.
 * Calibration only needs pAccept, not the whole graded decision.
 */
export type InsightGateSnapshot = { pAccept: number };

/**
 * Read the gate snapshot attached to an insight record. Returns null when the
 * record has no snapshot or the value is not a number.
 */
export function readInsightGateSnapshot(insight: InsightRecord): InsightGateSnapshot | null {
  const snapshot = (insight as InsightRecord & { gateSnapshot?: InsightGateSnapshot | null })
    .gateSnapshot;
  return snapshot && typeof snapshot.pAccept === "number" ? snapshot : null;
}

/**
 * Resolve the predicted pAccept for a calibration sample. Uses the gate
 * snapshot when usable; otherwise falls back to {@link DEFAULT_PREDICTED_PACCEPT}
 * and logs a warning so unwired upstream paths stay visible.
 */
export function resolvePredictedPAccept(
  insightId: string,
  snapshot?: InsightGateSnapshot | null,
): number {
  const pAccept = snapshot?.pAccept;
  if (typeof pAccept === "number" && Number.isFinite(pAccept)) {
    return Math.max(0, Math.min(1, pAccept));
  }
  log.warn("no usable gate snapshot for calibration — using fallback pAccept", {
    insightId,
    fallback: DEFAULT_PREDICTED_PACCEPT,
  });
  return DEFAULT_PREDICTED_PACCEPT;
}

export type NoResponseCalibrationInput = {
  /** Id of the unanswered insight; falls back to the latest recentInsightIds entry. */
  insightId?: string;
  /** Gate snapshot of the unanswered insight, used as the predicted pAccept. */
  gateSnapshot?: InsightGateSnapshot | null;
};

/**
 * Build the calibration sample for an unanswered delivered insight. Silence is
 * evidence of non-acceptance, so it belongs in the calibration history next to
 * explicit outcomes.
 */
export function recordNoResponseCalibration(
  persona: PersonaTree,
  input?: NoResponseCalibrationInput,
  nowMs?: number,
): CalibrationRecord {
  const insightId =
    input?.insightId ??
    persona.feedbackProfile.recentInsightIds.at(-1) ??
    `no-response:${persona.feedbackProfile.lastProactiveAt}`;
  return recordCalibration(
    insightId,
    resolvePredictedPAccept(insightId, input?.gateSnapshot),
    "no_response",
    nowMs,
  );
}

/**
 * Compute the calibration slope from history using simplified linear regression.
 *
 * slope = Σ(predicted × actual) / Σ(predicted²)
 *
 * - slope < 1 → system is overconfident (predicted high, actual low)
 * - slope > 1 → system is underconfident (predicted low, actual high)
 * - slope = 1 → perfectly calibrated
 *
 * Uses the last 50 records. Returns 1.0 (no correction) when < 10 records.
 */
export function computeCalibrationSlope(history: CalibrationRecord[]): number {
  if (history.length < MIN_RECORDS_FOR_RELIABLE) {
    return 1.0;
  }

  const window = history.slice(-MAX_CALIBRATION_RECORDS);

  let sumPredictedActual = 0;
  let sumPredictedSq = 0;

  for (const record of window) {
    const actual = POSITIVE_OUTCOMES.has(record.actualOutcome) ? 1 : 0;
    sumPredictedActual += record.predictedPAccept * actual;
    sumPredictedSq += record.predictedPAccept * record.predictedPAccept;
  }

  if (sumPredictedSq === 0) {
    return 1.0;
  }

  const slope = sumPredictedActual / sumPredictedSq;
  return Math.max(SLOPE_MIN, Math.min(SLOPE_MAX, slope));
}

/**
 * Apply calibration correction to a raw pAccept value.
 * adjustedPAccept = pAccept * slope, clamped to [0, 1].
 */
export function applyCalibrationCorrection(pAccept: number, slope: number): number {
  return Math.max(0, Math.min(1, pAccept * slope));
}

/**
 * Return calibration statistics for debugging / display.
 */
export function getCalibrationStats(history: CalibrationRecord[]): {
  slope: number;
  recordCount: number;
  isReliable: boolean;
} {
  return {
    slope: computeCalibrationSlope(history),
    recordCount: history.length,
    isReliable: history.length >= MIN_RECORDS_FOR_RELIABLE,
  };
}

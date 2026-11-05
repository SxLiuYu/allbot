import type { ImplicitFeedbackSignal } from "./types.js";

/** Named-options form for callers that hold a measured response latency. */
export type ImplicitSignalOptions = {
  /** Time the user took to reply, measured by the inbound path. */
  responseLatencyMs?: number;
  topic?: string;
  previousTopics?: string[];
};

/**
 * Extract implicit feedback signals from a conversation turn.
 *
 * Accepts either the legacy positional arguments or a named-options object
 * (`extractImplicitSignals(text, { responseLatencyMs, topic, previousTopics })`)
 * so the inbound path can pass a real, measured latency.
 */
export function extractImplicitSignals(
  userMessage: string,
  latencyOrOptions?: number | ImplicitSignalOptions,
  topicArg?: string,
  previousTopicsArg?: string[],
): ImplicitFeedbackSignal[] {
  const { responseLatencyMs, topic, previousTopics } =
    typeof latencyOrOptions === "object" && latencyOrOptions !== null
      ? latencyOrOptions
      : {
          responseLatencyMs: latencyOrOptions,
          topic: topicArg,
          previousTopics: previousTopicsArg,
        };
  const signals: ImplicitFeedbackSignal[] = [];

  signals.push({
    type: "response_length",
    topic,
    value: userMessage.length,
    timestamp: Date.now(),
  });

  if (
    responseLatencyMs !== undefined &&
    Number.isFinite(responseLatencyMs) &&
    responseLatencyMs >= 0
  ) {
    signals.push({
      type: "response_latency",
      topic,
      value: responseLatencyMs,
      timestamp: Date.now(),
    });
  }

  // Question depth — check if user asks deep follow-up questions
  const hasDeepQuestion = /(为什么|如何|怎样|what if|why|how come|深层|本质)/.test(userMessage);
  if (hasDeepQuestion) {
    signals.push({
      type: "question_depth",
      topic,
      value: 1,
      timestamp: Date.now(),
    });
  }

  // Topic continuation / abandonment detection
  if (topic && previousTopics && previousTopics.length > 0) {
    const recentTopics = previousTopics.slice(-3);
    const isContinuation = recentTopics.some((t) => t.toLowerCase() === topic.toLowerCase());
    if (isContinuation) {
      signals.push({
        type: "topic_continuation",
        topic,
        value: 1,
        timestamp: Date.now(),
      });
    } else if (recentTopics.length > 0) {
      const abandonedTopic = recentTopics[recentTopics.length - 1];
      signals.push({
        type: "topic_abandonment",
        topic: abandonedTopic,
        value: 1,
        timestamp: Date.now(),
      });
    }
  }

  return signals;
}

import type { PersonaTree } from "../types.js";

/**
 * Seeds owner-declared interests into a persona.
 *
 * `cognitive.insight.sources.explicitTopics` was schema-only: the config key
 * validated and was then never read, so "track these topics for me" had no
 * effect at all. Declared interests are the highest-confidence signal there
 * is (the user said it outright), yet the insight pipeline only ever saw
 * domains the curator had inferred from chat.
 *
 * Seeded domains are marked `source: "explicit"` on their insight so the
 * curator can tell a declared interest from an inferred one and will not
 * decay it away after a few quiet days.
 */

const SEED_DEPTH = 2;
const SEED_RECURRENCE = 1;
const KEY_INSIGHT_TEXT = "Declared as an explicit interest by the user";

/** Case-insensitive lookup so "Rust" and "rust" do not become two domains. */
function findExistingDomain(domains: Record<string, unknown>, topic: string): string | undefined {
  const lower = topic.toLowerCase();
  return Object.keys(domains).find((name) => name.toLowerCase() === lower);
}

/**
 * Adds any missing explicit topics to the persona and refreshes the recency
 * of ones already present. Idempotent: calling it on every load is fine and
 * is how a config change takes effect without editing persona files.
 */
export function applyExplicitTopics(
  persona: PersonaTree,
  topics: string[] | undefined,
): PersonaTree {
  if (!topics || topics.length === 0) {
    return persona;
  }

  const now = Date.now();
  let changed = false;

  for (const raw of topics) {
    const topic = raw.trim();
    if (!topic) {
      continue;
    }

    const existingName = findExistingDomain(persona.domains, topic);
    if (existingName) {
      const node = persona.domains[existingName]!;
      // Keep declared interests from decaying into the deleted state; the
      // rest of the node stays exactly as observed.
      if (node.depth < SEED_DEPTH) {
        node.depth = SEED_DEPTH;
        changed = true;
      }
      if (node.recurrence < SEED_RECURRENCE) {
        node.recurrence = SEED_RECURRENCE;
        changed = true;
      }
      if (node.lastMentioned < now) {
        node.lastMentioned = now;
        changed = true;
      }
      continue;
    }

    persona.domains[topic] = {
      depth: SEED_DEPTH,
      recurrence: SEED_RECURRENCE,
      lastMentioned: now,
      keyInsights: [KEY_INSIGHT_TEXT],
      insights: [
        {
          text: KEY_INSIGHT_TEXT,
          category: "durable",
          confidence: 0.95,
          source: "explicit",
          firstObserved: now,
          lastReinforced: now,
          evidenceCount: 1,
          halfLifeDays: 365,
        },
      ],
      activeQuestions: [],
      negationSignals: 0,
      phase: "stable",
      phaseEnteredAt: now,
    };
    changed = true;
  }

  if (changed) {
    // Identity lists feed the insight prompts directly; keep them aligned so
    // the generator sees the same declared interests the scheduler routes on.
    const declared = topics.map((t) => t.trim()).filter(Boolean);
    const merged = new Set([...persona.identity.interestDomains, ...declared]);
    persona.identity.interestDomains = [...merged];
  }

  return persona;
}

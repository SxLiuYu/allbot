import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { parseFrontmatterBlock } from "./frontmatter.js";

describe("parseFrontmatterBlock", () => {
  it("parses YAML block scalars", () => {
    const content = `---
name: yaml-hook
description: |
  line one
  line two
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.name).toBe("yaml-hook");
    expect(result.description).toBe("line one\nline two");
  });

  it("handles JSON5-style multi-line metadata", () => {
    const content = `---
name: session-memory
metadata:
  {
    "allbot":
      {
        "emoji": "disk",
        "events": ["command:new"],
      },
  }
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.metadata).toBeDefined();

    const parsed = JSON5.parse(result.metadata ?? "");
    expect(parsed.allbot?.emoji).toBe("disk");
  });

  it("preserves inline JSON values", () => {
    const content = `---
name: inline-json
metadata: {"allbot": {"events": ["test"]}}
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.metadata).toBe('{"allbot": {"events": ["test"]}}');
  });

  it("stringifies YAML objects and arrays", () => {
    const content = `---
name: yaml-objects
enabled: true
retries: 3
tags:
  - alpha
  - beta
metadata:
  allbot:
    events:
      - command:new
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.enabled).toBe("true");
    expect(result.retries).toBe("3");
    expect(JSON.parse(result.tags ?? "[]")).toEqual(["alpha", "beta"]);
    const parsed = JSON5.parse(result.metadata ?? "");
    expect(parsed.allbot?.events).toEqual(["command:new"]);
  });

  it("preserves inline description values containing colons", () => {
    const content = `---
name: sample-skill
description: Use anime style IMPORTANT: Must be kawaii
---`;
    const result = parseFrontmatterBlock(content);
    expect(result.description).toBe("Use anime style IMPORTANT: Must be kawaii");
  });

  it("does not replace YAML block scalars with block indicators", () => {
    const content = `---
name: sample-skill
description: |-
  {json-like text}
---`;
    const result = parseFrontmatterBlock(content);
    expect(result.description).toBe("{json-like text}");
  });

  it("keeps nested YAML mappings as structured JSON", () => {
    const content = `---
name: sample-skill
metadata:
  allbot: true
---`;
    const result = parseFrontmatterBlock(content);
    expect(result.metadata).toBe('{"allbot":true}');
  });

  it("returns empty when frontmatter is missing", () => {
    const content = "# No frontmatter";
    expect(parseFrontmatterBlock(content)).toEqual({});
  });
});

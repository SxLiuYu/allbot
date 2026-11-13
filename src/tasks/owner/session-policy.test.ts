import { describe, expect, it } from "vitest";
import { canRegisterOwnerTaskWriteTools } from "./session-policy.js";

describe("canRegisterOwnerTaskWriteTools", () => {
  it("allows owner write tools in a Router session", () => {
    expect(canRegisterOwnerTaskWriteTools("agent:main:main")).toBe(true);
    expect(canRegisterOwnerTaskWriteTools("agent:main:feishu:direct:ou_owner")).toBe(true);
  });

  it("blocks owner write tools in subagent and cron sessions", () => {
    expect(canRegisterOwnerTaskWriteTools("agent:main:subagent:worker")).toBe(false);
    expect(canRegisterOwnerTaskWriteTools("agent:main:cron:job-1:run:abc")).toBe(false);
  });

  it("blocks owner write tools in group/channel sessions", () => {
    expect(canRegisterOwnerTaskWriteTools("agent:main:discord:group:g1")).toBe(false);
    expect(canRegisterOwnerTaskWriteTools("agent:main:slack:channel:c1")).toBe(false);
  });
});

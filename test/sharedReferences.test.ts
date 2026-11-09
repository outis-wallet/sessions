import { describe, expect, it } from "vitest";
import { parseRequest, typedDataOf } from "../src/protocol";
import { ALICE, DELEGATION, SEPOLIA } from "./fakes";

// A structured clone keeps shared references and cycles, which JSON has neither of. Walked path by
// path, a message of a few dozen objects that share each other would take the window seconds (or,
// with a cycle of fan-out 2, 2^32 steps) before being refused, and a listed site, or a script on it,
// could hang the user's sign window. The walk visits each object once, within a size budget.

const sign = (typedData: unknown) => ({ outis: "sessions", v: 1, kind: "request", id: "ab".repeat(16), method: "signTypedData", chainId: SEPOLIA, account: ALICE, typedData });

/** `levels` objects, each holding the next one twice: 2^levels leaves to JSON, `levels` objects in memory. */
function dag(levels: number): unknown {
  let node: unknown = "leaf";
  for (let i = 0; i < levels; i++) node = { a: node, b: node };
  return node;
}

describe("shared references in a structured clone", () => {
  it("settles a message of 22 shared objects in well under a second", () => {
    const typedData = structuredClone({ ...DELEGATION, message: { m: dag(21) } });
    const started = performance.now();
    const parsed = parseRequest(sign(typedData));
    const elapsed = performance.now() - started;
    // Refused (over the length cap) is fine; taking this long is not: the window is single-threaded.
    expect(parsed).toBeNull();
    expect(elapsed).toBeLessThan(100);
  });

  it("refuses a cyclic message at once rather than walking 2^depth paths", () => {
    // A cycle of fan-out 2: `isJson`'s depth cap of 32 bounds the recursion, not the paths (2^32).
    // Fan-out 1 shows the mechanism in bounded time: 32 steps, refused at depth 0.
    const m: Record<string, unknown> = {};
    m.a = m;
    const started = performance.now();
    expect(typedDataOf({ ...DELEGATION, message: m })).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(50);
    // Fan-out 2 at a cap of 32 would be 4 billion steps: not run here. The fix must refuse an object
    // seen twice, which settles both in a handful of steps.
  });
});

import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("rejects a tiny structured-clone DAG exceeding the JSON size budget without expanding it", () => {
  const protocolUrl = new URL("../src/protocol.ts", import.meta.url).href;
  // Isolate the intentionally expensive parser call so the regression cannot freeze vitest.
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { parseRequest } from ${JSON.stringify(protocolUrl)};
    let x = 0;
    for (let i = 0; i < 29; i++) x = { a: x, b: x };
    const request = structuredClone({
      outis: "sessions", v: 1, kind: "request", id: "ab".repeat(16),
      method: "signTypedData", chainId: "0x1", account: null,
      typedData: { types: {}, primaryType: "X", domain: {}, message: { x } }
    });
    console.log(parseRequest(request));
  `], { encoding: "utf8", timeout: 2000, maxBuffer: 4096 });
  expect({ status: child.status, signal: child.signal, output: child.stdout.trim() })
    .toEqual({ status: 0, signal: null, output: "null" });
});

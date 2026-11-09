import { describe, expect, it } from "vitest";
import { findExtension, outisWallet } from "../src/wallet";

// Only a whole wallet object is taken for the extension: `id: "outis"`, a name and a version, and
// `request`, `on` and `off`. get-starknet's discovery wants `on` and `off` too, and a wallet without
// them would throw on `on()`.

describe("an object that isn't a whole wallet object", () => {
  it("is not taken for the extension", () => {
    const scope = { starknet_outis: { id: "outis", name: "Outis", version: "0.0.0", icon: "", request: async () => null } };
    expect(findExtension(scope)).toBeUndefined();
  });

  it("does not make a wallet whose on() throws", () => {
    (globalThis as Record<string, unknown>).starknet_outis = { id: "outis", request: async () => null };
    try {
      const wallet = outisWallet({ chainId: "0x534e5f5345504f4c4941" });
      expect(() => wallet.on("accountsChanged", () => {})).not.toThrow();
    } finally {
      delete (globalThis as Record<string, unknown>).starknet_outis;
    }
  });
});

import { describe, expect, it } from "vitest";
import { Cl, serializeCV } from "@stacks/transactions";
import { decodeEvent, asHex, asInt } from "../src/indexers/decode.js";
import { buildAuthMessage, generateNonce } from "../src/auth/message.js";

describe("event decoder", () => {
  it("decodes a shielded print tuple into flat fields", () => {
    const tuple = Cl.tuple({
      event: Cl.stringAscii("shielded"),
      commitment: Cl.bufferFromHex("aa".repeat(32)),
      "leaf-index": Cl.uint(3),
      amount: Cl.uint(1_000_000),
      fee: Cl.uint(300),
      "new-root": Cl.bufferFromHex("bb".repeat(32)),
      height: Cl.uint(42),
    });
    const decoded = decodeEvent(serializeCV(tuple));
    expect(decoded).not.toBeNull();
    expect(decoded!.event).toBe("shielded");
    expect(asHex(decoded!.fields["commitment"])).toBe("0x" + "aa".repeat(32));
    expect(asInt(decoded!.fields["leaf-index"])).toBe(3);
    expect(asInt(decoded!.fields["amount"])).toBe(1_000_000);
    expect(asHex(decoded!.fields["new-root"])).toBe("0x" + "bb".repeat(32));
    expect(asInt(decoded!.fields["height"])).toBe(42);
  });

  it("returns null for a tuple without an event field", () => {
    const tuple = Cl.tuple({ foo: Cl.uint(1) });
    expect(decodeEvent(serializeCV(tuple))).toBeNull();
  });

  it("returns null for non-tuple values", () => {
    expect(decodeEvent(serializeCV(Cl.uint(1)))).toBeNull();
  });
});

describe("auth message", () => {
  it("embeds wallet, nonce and timestamp deterministically", () => {
    const wallet = "ST3X83R4JTYPJRP42QSQBGG0Q5X8J2NBFD3HF248T";
    const nonce = generateNonce();
    const msg = buildAuthMessage(wallet, nonce, "2026-07-29T00:00:00.000Z");
    expect(msg).toContain(wallet);
    expect(msg).toContain(nonce);
    expect(msg).toContain("2026-07-29T00:00:00.000Z");
    // the nonce is recoverable by the same regex the verify route uses
    expect(msg.match(/Nonce:\n([0-9a-f]{64})/)?.[1]).toBe(nonce);
  });

  it("generates 32-byte hex nonces", () => {
    expect(generateNonce()).toMatch(/^[0-9a-f]{64}$/);
  });
});

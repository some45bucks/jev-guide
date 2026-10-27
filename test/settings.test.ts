import { describe, expect, it } from "vitest";
import { normalizeBaseUrl, originPattern } from "../src/shared/settings";

describe("normalizeBaseUrl", () => {
  it("trims spaces and trailing slashes", () => {
    expect(normalizeBaseUrl("  https://api.typesafe.ai/  ")).toBe("https://api.typesafe.ai");
  });
  it("keeps a base path", () => {
    expect(normalizeBaseUrl("https://openrouter.ai/api")).toBe("https://openrouter.ai/api");
  });
  it("accepts a pasted full endpoint and keeps only the base", () => {
    expect(normalizeBaseUrl("https://api.typesafe.ai/v1/systemone")).toBe("https://api.typesafe.ai");
  });
  it("allows plain http only for localhost", () => {
    expect(normalizeBaseUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(() => normalizeBaseUrl("http://example.com")).toThrow(/https/);
  });
  it("rejects text that isn't a URL", () => {
    expect(() => normalizeBaseUrl("api.typesafe.ai")).toThrow(/valid URL/);
  });
});

describe("originPattern", () => {
  it("covers the whole origin, path or not", () => {
    expect(originPattern("https://openrouter.ai/api")).toBe("https://openrouter.ai/*");
  });
});

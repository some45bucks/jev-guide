import { describe, expect, it } from "vitest";
import { normalizeBaseUrl, originPattern, pagePattern } from "../src/shared/settings";

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
  it("leaves out the port, so local servers fall under the manifest's localhost pattern", () => {
    expect(originPattern("http://localhost:8123/account.html")).toBe("http://localhost/*");
  });
});

describe("pagePattern", () => {
  it("allows https pages", () => {
    expect(pagePattern("https://shop.example/account?tab=billing")).toBe("https://shop.example/*");
  });
  it("allows local servers over http", () => {
    expect(pagePattern("http://127.0.0.1:8123/")).toBe("http://127.0.0.1/*");
  });
  it("refuses pages Chrome or the manifest won't let it script", () => {
    expect(pagePattern("http://shop.example/")).toBeNull();
    expect(pagePattern("chrome://extensions/")).toBeNull();
    expect(pagePattern("file:///home/me/page.html")).toBeNull();
    expect(pagePattern(undefined)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { buildTestRequest, callJev, describeHttpError, endpointUrl, JevError, parseJevResponse } from "../src/shared/jev";

describe("endpointUrl", () => {
  it("appends the System One path", () => {
    expect(endpointUrl("https://api.typesafe.ai")).toBe("https://api.typesafe.ai/v1/systemone");
  });
  it("keeps a base path such as OpenRouter's /api", () => {
    expect(endpointUrl("https://openrouter.ai/api/")).toBe("https://openrouter.ai/api/v1/systemone");
  });
});

describe("buildTestRequest", () => {
  it("asks one noul about the state", () => {
    const req = buildTestRequest("jev-latest");
    expect(req.model).toBe("jev-latest");
    expect(Object.values(req.questions)).toEqual([{ type: "noul", instructions: expect.stringContaining("`message`") }]);
  });
});

describe("parseJevResponse", () => {
  // Shaped like real responses captured from the API.
  const body = {
    model: "jev-1.14.0",
    answers: {
      next_click: { type: "choice", choice: "e12", confidence: 0.63, probabilities: { e12: 0.72, e40: 0.28 } },
      goal_reached: { type: "noul", noul: 0.04 },
      specificity: { type: "score", score: 1.2, confidence: 0.5, probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 } },
    },
    usage: { input_tokens: 398, output_tokens: 45 },
  };

  it("reads all three answer types and token usage", () => {
    const parsed = parseJevResponse(body);
    expect(parsed.model).toBe("jev-1.14.0");
    expect(parsed.answers.next_click).toEqual(body.answers.next_click);
    expect(parsed.answers.goal_reached).toEqual({ type: "noul", noul: 0.04 });
    expect(parsed.answers.specificity?.type).toBe("score");
    expect(parsed.inputTokens).toBe(398);
  });

  it("treats a missing confidence as null", () => {
    const parsed = parseJevResponse({ answers: { q: { type: "choice", choice: "a", probabilities: { a: 1 } } } });
    expect(parsed.answers.q).toMatchObject({ confidence: null });
  });

  it("skips answer types it doesn't know", () => {
    const parsed = parseJevResponse({ answers: { b: { type: "box", box: { top: 0 } } } });
    expect(parsed.answers).toEqual({});
  });

  it("rejects a response without answers", () => {
    expect(() => parseJevResponse({ model: "x" })).toThrow(JevError);
  });

  it("rejects a malformed choice", () => {
    expect(() => parseJevResponse({ answers: { q: { type: "choice", probabilities: {} } } })).toThrow(/malformed/);
  });
});

describe("describeHttpError", () => {
  it("explains a rejected key", () => {
    expect(describeHttpError(401, {})).toMatch(/API key was rejected/);
  });
  it("includes TypeSafe usage errors", () => {
    // Captured from the live API for an unknown model name.
    const body = { detail: { error_type: "api_usage_error", message: "Unknown model: no-such-model" } };
    expect(describeHttpError(400, body)).toBe("The API returned an error (400): Unknown model: no-such-model");
  });
  it("includes TypeSafe validation details", () => {
    expect(describeHttpError(422, { detail: [{ msg: "Field required" }] })).toBe("The API returned an error (422): Field required");
  });
  it("includes OpenRouter-style error messages", () => {
    expect(describeHttpError(400, { error: { message: "Unknown model" } })).toBe("The API returned an error (400): Unknown model");
  });
});

describe("callJev", () => {
  const conn = { apiKey: "test-key", baseUrl: "https://api.typesafe.ai" };

  it("posts the request with the key and parses the reply", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ model: "jev-1.14.0", answers: { g: { type: "noul", noul: 0.9 } } }), { status: 200 });
    }) as typeof fetch;

    const result = await callJev(conn, buildTestRequest("jev-latest"), fakeFetch);
    expect(seen?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((seen?.init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(seen?.init.body as string).model).toBe("jev-latest");
    expect(result.answers.g).toEqual({ type: "noul", noul: 0.9 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("turns an HTTP error into a readable JevError", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ detail: "bad key" }), { status: 401 })) as typeof fetch;
    await expect(callJev(conn, buildTestRequest("jev-latest"), fakeFetch)).rejects.toMatchObject({ status: 401 });
  });

  it("turns a network failure into a readable JevError", async () => {
    const fakeFetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    await expect(callJev(conn, buildTestRequest("jev-latest"), fakeFetch)).rejects.toThrow(/Couldn't reach api.typesafe.ai/);
  });
});

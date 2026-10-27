// Jev API client: request/response types, a response parser, and one fetch wrapper.
// Everything except the network call is a pure function, so it can be unit-tested
// without a browser.

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] };

export interface JevRequest {
  model: string;
  state: unknown;
  questions: Record<string, JevQuestion>;
}

export type JevAnswer =
  | { type: "choice"; choice: string; confidence: number | null; probabilities: Record<string, number> }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence: number | null; probabilities: Record<string, number> };

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  inputTokens: number | null;
}

export interface JevResult extends JevResponse {
  latencyMs: number;
}

export interface Connection {
  apiKey: string;
  baseUrl: string;
}

/** An error whose message is written for the person using the extension. */
export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JevError";
  }
}

const TIMEOUT_MS = 20_000;

/** The base URL is configurable so the same code works for TypeSafe and for OpenRouter. */
export function endpointUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "") + "/v1/systemone";
}

/** The smallest useful request: one noul whose answer we can predict, so a pass is meaningful. */
export function buildTestRequest(model: string): JevRequest {
  return {
    model,
    state: { message: "Hello from Jev Guide. This request checks that the API key works." },
    questions: {
      is_greeting: { type: "noul", instructions: "Does `message` contain a greeting?" },
    },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isProbabilities(v: unknown): v is Record<string, number> {
  return isObject(v) && Object.values(v).every((p) => typeof p === "number");
}

function confidenceOf(raw: Record<string, unknown>): number | null {
  return typeof raw.confidence === "number" ? raw.confidence : null;
}

/**
 * Checks the response shape instead of trusting it, because later stages act on these
 * answers, and a malformed answer should fail loudly rather than highlight the wrong element.
 */
export function parseJevResponse(body: unknown): JevResponse {
  if (!isObject(body) || !isObject(body.answers)) {
    throw new JevError("The API sent a response without answers.");
  }
  const answers: Record<string, JevAnswer> = {};
  for (const [id, raw] of Object.entries(body.answers)) {
    if (!isObject(raw)) throw new JevError(`Answer "${id}" is malformed.`);
    if (raw.type === "choice") {
      if (typeof raw.choice !== "string" || !isProbabilities(raw.probabilities)) {
        throw new JevError(`Choice answer "${id}" is malformed.`);
      }
      answers[id] = { type: "choice", choice: raw.choice, confidence: confidenceOf(raw), probabilities: raw.probabilities };
    } else if (raw.type === "noul") {
      if (typeof raw.noul !== "number") throw new JevError(`Noul answer "${id}" is malformed.`);
      answers[id] = { type: "noul", noul: raw.noul };
    } else if (raw.type === "score") {
      if (typeof raw.score !== "number" || !isProbabilities(raw.probabilities)) {
        throw new JevError(`Score answer "${id}" is malformed.`);
      }
      answers[id] = { type: "score", score: raw.score, confidence: confidenceOf(raw), probabilities: raw.probabilities };
    }
    // Other answer types (such as "box") are skipped, so a newer API version
    // doesn't break questions this extension never asks.
  }
  const usage = isObject(body.usage) ? body.usage : {};
  return {
    model: typeof body.model === "string" ? body.model : "unknown",
    answers,
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
  };
}

/** Pulls a readable message out of an error body. TypeSafe and OpenRouter shape these differently. */
export function errorDetail(body: unknown): string | null {
  if (!isObject(body)) return null;
  if (typeof body.detail === "string") return body.detail;
  if (isObject(body.detail) && typeof body.detail.message === "string") return body.detail.message;
  if (Array.isArray(body.detail) && isObject(body.detail[0]) && typeof body.detail[0].msg === "string") {
    return body.detail[0].msg;
  }
  if (isObject(body.error) && typeof body.error.message === "string") return body.error.message;
  if (typeof body.message === "string") return body.message;
  return null;
}

export function describeHttpError(status: number, body: unknown): string {
  const detail = errorDetail(body);
  if (status === 401) return "The API key was rejected (401). Check the key in Options.";
  if (status === 403) return `This key isn't allowed to make that request (403).${detail ? " " + detail : ""}`;
  if (status === 429) return "Too many requests (429). Wait a moment and try again.";
  return `The API returned an error (${status})${detail ? ": " + detail : "."}`;
}

/**
 * Sends one request. `fetchFn` is a parameter so tests can pass a fake instead of
 * hitting the network.
 */
export async function callJev(conn: Connection, request: JevRequest, fetchFn: typeof fetch = fetch): Promise<JevResult> {
  const url = endpointUrl(conn.baseUrl);
  const host = new URL(url).host;
  const started = performance.now();
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${conn.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new JevError(`${host} didn't answer within ${TIMEOUT_MS / 1000} seconds.`);
    }
    throw new JevError(`Couldn't reach ${host}. Check the base URL and your internet connection.`);
  }
  const latencyMs = Math.round(performance.now() - started);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (!res.ok) throw new JevError(describeHttpError(res.status, body), res.status);
  return { ...parseJevResponse(body), latencyMs };
}

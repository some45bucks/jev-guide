// Serves test/fixtures at http://127.0.0.1:8123 so the extension can be tried on the fake
// Account → Billing → Cancel flow. Local servers are already in the manifest's optional host
// permissions, while file:// pages would need Chrome's "Allow access to file URLs" switch.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../test/fixtures/", import.meta.url));
const PORT = 8123;
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8" };

createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const file = normalize(join(ROOT, path === "/" ? "index.html" : decodeURIComponent(path)));
  // Only files inside the fixtures folder, whatever the URL says.
  if (!file.startsWith(ROOT)) return res.writeHead(403).end("Forbidden");
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    // Links to pages outside the flow (Browse, Help) land here on purpose.
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not part of the test site.");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Fixture site: http://127.0.0.1:${PORT}/  (Ctrl+C to stop)`));

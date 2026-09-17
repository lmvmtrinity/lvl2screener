// Local fixture API for the browser visual-verification harness.
//
//   POST /__scenario  { "name": "healthy" | "waiting" | "failure" | "empty" }
//   GET  /api/...     fixtures for the active scenario
//
// Runs on its own; screenshot.mjs imports startVisualServer() and stops it in a
// finally block. The Vite dev server proxies /api here (vite.visual.config.mjs).
import { createServer } from "node:http";
import {
  SCENARIOS,
  fixtureSet,
  resolveRequest,
  resolveUniversePaste,
} from "./fixtures.mjs";

export function startVisualServer({
  port = 5198,
  initialScenario = "healthy",
} = {}) {
  let scenario = initialScenario;
  // Build every scenario once at startup so a schema drift fails loudly here,
  // not silently as an error banner in a screenshot.
  for (const name of SCENARIOS) fixtureSet(name);

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://localhost:${port}`);

    if (request.method === "POST" && url.pathname === "/__scenario") {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        try {
          const body = JSON.parse(raw || "{}");
          if (!SCENARIOS.includes(body.name)) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                error: `Unknown scenario ${body.name}`,
                scenarios: SCENARIOS,
              }),
            );
            return;
          }
          scenario = body.name;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ scenario }));
        } catch (reason) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: String(reason) }));
        }
      });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/")) {
      const result = resolveRequest(scenario, url.pathname, url.searchParams);
      response.writeHead(result.status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(result.body));
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/universe/candidates"
    ) {
      // Drain the request body; the harness response is deterministic and does
      // not depend on the submitted symbols.
      request.on("end", () => {
        const result = resolveUniversePaste(scenario);
        response.writeHead(result.status, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify(result.body));
      });
      request.resume();
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        server,
        port,
        get scenario() {
          return scenario;
        },
        setScenario(name) {
          if (!SCENARIOS.includes(name)) throw new Error(`Unknown ${name}`);
          scenario = name;
        },
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

const isDirectRun = process.argv[1]
  ?.replaceAll("\\", "/")
  .endsWith("server.mjs");
if (isDirectRun) {
  const handle = await startVisualServer();
  console.log(`visual fixture API on http://127.0.0.1:${handle.port}`);
}

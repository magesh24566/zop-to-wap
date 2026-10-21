// taskManager API. Start: `bun start`. Settings: config.ts. See README.md.
import { timingSafeEqual } from "node:crypto";
import { API_KEY, HOST, POLL, POLL_SECONDS, PORT, RULES, SOURCE_PORTAL, TARGET_PORTAL } from "./config";
import { activity, check, log, mirror, startPoller, status } from "./mirror";

const json = (body: unknown, code = 200) => Response.json(body, { status: code, headers: { "Cache-Control": "no-store" } });
const keyOk = (req: Request) => {
  const a = Buffer.from(req.headers.get("x-api-key") ?? ""), b = Buffer.from(API_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
};
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

export async function handle(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  // Status: no secrets in it.
  if (pathname === "/" || pathname === "/api/status") {
    return json({ source: SOURCE_PORTAL, target: TARGET_PORTAL, rules: RULES, polling: POLL ? `every ${POLL_SECONDS}s` : "off", ...status, activity });
  }
  if (!keyOk(req)) return json({ error: "Wrong or missing X-Api-Key." }, 401);
  if (pathname === "/api/check" && req.method === "GET") return json(await check());
  if (pathname === "/api/mirror" && req.method === "POST") {
    const t: any = await req.json().catch(() => null);
    if (!t || ![t.id, t.project, t.name].every((v) => typeof v === "string" && v)) return json({ error: "Need id, project and name." }, 400);
    const r = await mirror({ id: t.id, project: t.project, name: t.name, description: String(t.description ?? ""), tags: list(t.tags), owners: list(t.owners) });
    return json(r, r.ok ? 200 : 502);
  }
  return json({ error: "Not found." }, 404);
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    console.log(JSON.stringify(await check(), null, 2));
    process.exit(0);
  }
  Bun.serve({ hostname: HOST, port: PORT, fetch: (req) => handle(req).catch((e) => (log("WARN", `request failed: ${e}`), json({ error: "Internal error." }, 500))) });
  log("INFO", `taskManager API on http://${HOST}:${PORT}  (source ${SOURCE_PORTAL} → target ${TARGET_PORTAL})`);
  if (POLL) startPoller(POLL_SECONDS);
}

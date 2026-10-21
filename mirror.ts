// Task mirror: a task created in the source portal's CaaS or DaaS project is created again in the target portal's
// project of the same name and assigned to the person the rules pick (first match wins):
//   1. tag "internal"                      → not mirrored
//   2. already assigned to a RULES person  → stays with that person (any project)
//   3. tag "zden"                          → RULES.zden
//   4. DaaS + tag "people"                 → RULES.people
//   5. CaaS                                → RULES.caas
//   6. DaaS                                → RULES.daas
// Tags and project names match in any case. The task is created with the assignee's own token when they have one
// (Created By = them), otherwise with READER's token.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as config from "./config";
import type { User } from "./config";

export type Config = Pick<typeof config, "USERS" | "RULES" | "SOURCE_PORTAL" | "TARGET_PORTAL" | "READER">;
/** One source task. owners = emails. */
export type SourceTask = { id: string; project: string; name: string; description?: string; tags: string[]; owners: string[] };
type Person = User & { key: string };

let cfg: Config = config;
export const useConfig = (c: Config) => ((cfg = c), cache.clear()); // tests

export const log = (level: "INFO" | "WARN", msg: string) => console.log(`${new Date().toISOString()} ${level.padEnd(4)} ${msg}`);

// A value still in "<...>" form is a placeholder, not a credential.
const real = (v?: string) => !!v && !v.startsWith("<");
export const hasCreds = (u: User) => real(u.clientId) && real(u.clientSecret) && real(u.refreshToken);
const person = (key: string): Person | undefined => (cfg.USERS[key] ? { ...cfg.USERS[key], key } : undefined);

/** The person a task goes to, or why it is not mirrored. */
export function route(t: SourceTask): { person: Person } | { skip: string } {
  const tags = new Set(t.tags.map((x) => x.trim().toLowerCase()));
  if (tags.has("internal")) return { skip: "tagged Internal" };
  const project = t.project.trim().toLowerCase();
  if (project !== "caas" && project !== "daas") return { skip: `project "${t.project}" is not CaaS/DaaS` };
  const owners = new Set(t.owners.map((e) => e.toLowerCase()));
  const kept = Object.values(cfg.RULES).map(person).find((p) => p && real(p.email) && owners.has(p.email.toLowerCase()));
  if (kept) return { person: kept };
  const rule: keyof typeof cfg.RULES = tags.has("zden") ? "zden" : project === "daas" && tags.has("people") ? "people" : project;
  const p = person(cfg.RULES[rule]);
  return p ? { person: p } : { skip: `RULES.${rule} = "${cfg.RULES[rule]}" is not in USERS` };
}

/** Whose token creates a task for p: p's own, else READER's. */
function creatorFor(p: Person) {
  if (hasCreds(p)) return p;
  const reader = person(cfg.READER);
  if (!reader || !hasCreds(reader)) throw new Error(`${p.name} has no credentials and READER "${cfg.READER}" has none either`);
  return reader;
}

// ---------- state: source task id → copy id (or skip reason), so each task is mirrored once ----------
const DATA = process.env.TASKMANAGER_DATA ?? join(import.meta.dir, "data");
const STATE = () => join(DATA, "state.json");
type State = { seen: Record<string, string>; primed: Record<string, boolean> };
const loadState = (): State => {
  try {
    return { seen: {}, primed: {}, ...JSON.parse(readFileSync(STATE(), "utf8")) };
  } catch {
    return { seen: {}, primed: {} };
  }
};
const saveState = (s: State) => {
  mkdirSync(DATA, { recursive: true, mode: 0o700 });
  writeFileSync(STATE() + ".tmp", JSON.stringify(s, null, 2), { mode: 0o600 });
  renameSync(STATE() + ".tmp", STATE());
};

// ---------- Zoho API ----------
const tokens = new Map<string, { token: string; until: number }>();
const cache = new Map<string, Promise<any>>(); // portal / project / user ids
const once = <T>(key: string, f: () => Promise<T>): Promise<T> => {
  if (!cache.has(key)) cache.set(key, f().catch((e) => (cache.delete(key), Promise.reject(e))));
  return cache.get(key)!;
};

// Access tokens live an hour and Zoho limits refreshes, so each one is reused until 5 min before it expires.
async function accessToken(p: Person) {
  const hit = tokens.get(p.refreshToken!);
  if (hit && hit.until > Date.now()) return hit.token;
  const r = await fetch(`https://accounts.${p.dc}/oauth/v2/token`, {
    method: "POST",
    body: new URLSearchParams({ refresh_token: p.refreshToken!, client_id: p.clientId!, client_secret: p.clientSecret!, grant_type: "refresh_token" }),
  });
  const d: any = await r.json().catch(() => ({}));
  if (!d.access_token) throw new Error(`${p.name} (${p.dc}): token refused (${d.error ?? r.status})`);
  tokens.set(p.refreshToken!, { token: d.access_token, until: Date.now() + (Number(d.expires_in ?? 3600) - 300) * 1000 });
  return d.access_token as string;
}

async function api(p: Person, path: string, body?: unknown) {
  const r = await fetch(`https://projectsapi.${p.dc}/api/v3${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Zoho-oauthtoken " + (await accessToken(p)), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p.name} (${p.dc}): ${body ? "POST" : "GET"} ${path.split("?")[0]} → ${r.status} ${d?.error?.title ?? d?.error?.message ?? ""}`.trim());
  return d;
}

const portalId = (p: Person, portal: string) => /^\d+$/.test(portal) ? Promise.resolve(portal) : once(`portal:${p.dc}:${portal}`, async () => {
  const list: any[] = await api(p, "/portals");
  const hit = list.find((x) => [x.portal_name, x.org_name].some((n) => String(n).toLowerCase() === portal.toLowerCase()));
  if (!hit) throw new Error(`${p.name} (${p.dc}) cannot see portal "${portal}"`);
  return String(hit.id);
});

const projectId = (p: Person, portal: string, name: string) => once(`project:${p.dc}:${portal}:${name.toLowerCase()}`, async () => {
  const list: any[] = await api(p, `/portal/${portal}/projects`);
  const hit = list.find((x) => String(x.name).trim().toLowerCase() === name.toLowerCase());
  if (!hit) throw new Error(`${p.name} (${p.dc}) cannot see a "${name}" project in portal ${portal}`);
  return String(hit.id);
});

/** The project user id (zpuid) of email, looked up with c's token. */
const zpuid = (c: Person, portal: string, project: string, email: string) => once(`user:${c.dc}:${project}:${email.toLowerCase()}`, async () => {
  const d = await api(c, `/portal/${portal}/projects/${project}/users`);
  const hit = (d.users ?? []).find((u: any) => String(u.email).toLowerCase() === email.toLowerCase());
  if (!hit) throw new Error(`${email} is not a user of target project ${project}`);
  return String(hit.zpuid ?? hit.id);
});

// ---------- mirror ----------
export type Outcome = { at: string; task: string; name: string; result: string; ok: boolean };
export const activity: Outcome[] = []; // newest first, shown by GET /api/status

let chain = Promise.resolve<unknown>(null); // one at a time, so a task seen twice is only created once

/** Mirrors one source task. Repeats return the first result; failures are retried on the next call. */
export function mirror(t: SourceTask): Promise<{ ok: boolean; result: string; target?: string }> {
  const run = chain.then(async () => {
    const state = loadState();
    if (state.seen[t.id]) return { ok: true, result: `already handled: ${state.seen[t.id]}` };
    const r = route(t);
    let result: string, target: string | undefined, ok = true;
    if ("skip" in r) result = "skipped: " + r.skip;
    else {
      try {
        const p = r.person, c = creatorFor(p);
        const portal = await portalId(c, cfg.TARGET_PORTAL);
        const project = await projectId(c, portal, t.project.trim());
        const body = { name: t.name, description: t.description ?? "", owners_and_work: { owners: [{ add: [{ zpuid: await zpuid(c, portal, project, p.email) }] }] } };
        const d = await api(c, `/portal/${portal}/projects/${project}/tasks`, body);
        const task = d.tasks?.[0] ?? d;
        target = String(task.id);
        result = `created ${task.prefix ?? target} in ${t.project} for ${p.name} (by ${c.name})`;
      } catch (e: any) {
        ok = false;
        result = "failed: " + (e?.message ?? e);
      }
    }
    if (ok) saveState({ ...state, seen: { ...state.seen, [t.id]: target ?? result } });
    activity.unshift({ at: new Date().toISOString(), task: t.id, name: t.name, result, ok });
    activity.length = Math.min(activity.length, 50);
    log(ok ? "INFO" : "WARN", `${t.id} "${t.name}": ${result}`);
    return { ok, result, target };
  });
  chain = run.catch(() => null);
  return run;
}

/** v3 task JSON → SourceTask. */
export const fromApi = (x: any, project: string): SourceTask => ({
  id: String(x.id), project, name: String(x.name ?? ""), description: x.description ?? "",
  tags: (x.tags ?? []).map((g: any) => String(typeof g === "string" ? g : g?.name ?? "")),
  owners: (x.owners_and_work?.owners ?? []).map((o: any) => String(o?.email ?? "")).filter(Boolean),
});

/** One poll: newest 50 tasks of the source CaaS and DaaS. The first poll of a project only marks what is already
 *  there, so old tasks are never copied. */
export async function pollOnce() {
  const reader = person(cfg.READER);
  if (!reader || !hasCreds(reader)) throw new Error(`READER "${cfg.READER}" has no credentials`);
  const portal = await portalId(reader, cfg.SOURCE_PORTAL);
  const errors: string[] = [];
  for (const name of ["CaaS", "DaaS"]) {
    let project: string;
    try {
      project = await projectId(reader, portal, name);
    } catch (e: any) {
      errors.push(String(e?.message ?? e)); // a missing project must not stop the other one
      continue;
    }
    // Newest 50 per poll: more new tasks than that in one interval and the oldest of them are missed.
    const d = await api(reader, `/portal/${portal}/projects/${project}/tasks?page=1&per_page=50&sort_by=DESC(created_time)`);
    const tasks = ((d.tasks ?? []) as any[]).filter((x) => !x.depth); // subtasks are not copied
    const state = loadState();
    if (!state.primed[project]) {
      for (const x of tasks) state.seen[String(x.id)] ??= "existed before mirroring started";
      saveState({ ...state, primed: { ...state.primed, [project]: true } });
      log("INFO", `watching source ${name} (${tasks.length} existing tasks left alone)`);
      continue;
    }
    for (const x of tasks.reverse()) if (!state.seen[String(x.id)]) await mirror(fromApi(x, name));
  }
  if (errors.length) throw new Error(errors.join("; "));
}

export const status = { lastPoll: "", lastError: "" };

export function startPoller(seconds: number) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await pollOnce();
      status.lastError = "";
    } catch (e: any) {
      const m = String(e?.message ?? e);
      if (m !== status.lastError) log("WARN", `poll failed: ${m}`); // once per new error, not every interval
      status.lastError = m;
    } finally {
      status.lastPoll = new Date().toISOString();
      busy = false;
    }
  };
  tick();
  return setInterval(tick, seconds * 1000);
}

/** Tokens, the source projects, and each rule's target project and assignee. */
export async function check() {
  const out: Record<string, string> = {};
  const attempt = async (label: string, f: () => Promise<string>) => {
    try {
      out[label] = await f();
    } catch (e: any) {
      out[label] = String(e?.message ?? e);
    }
  };
  for (const [key, u] of Object.entries(cfg.USERS))
    if (hasCreds(u)) await attempt(`token ${key}`, async () => (await accessToken({ ...u, key }), "OK"));
  const reader = person(cfg.READER);
  if (!reader || !hasCreds(reader)) return { ...out, reader: `READER "${cfg.READER}" has no credentials` };
  for (const n of ["CaaS", "DaaS"])
    await attempt(`source ${n}`, async () => (await projectId(reader, await portalId(reader, cfg.SOURCE_PORTAL), n), `OK: ${reader.name} reads it`));
  for (const [rule, key] of Object.entries(cfg.RULES)) {
    const p = person(key);
    if (!p) {
      out[`rule ${rule}`] = `"${key}" is not in USERS`;
      continue;
    }
    for (const n of rule === "caas" ? ["CaaS"] : rule === "zden" ? ["CaaS", "DaaS"] : ["DaaS"])
      await attempt(`rule ${rule}: target ${n}`, async () => {
        const c = creatorFor(p);
        const portal = await portalId(c, cfg.TARGET_PORTAL);
        await zpuid(c, portal, await projectId(c, portal, n), p.email);
        return `OK: created by ${c.name}, assigned to ${p.name}`;
      });
  }
  return out;
}

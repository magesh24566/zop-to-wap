// `bun test`: the rules, and one full create against a fake Zoho. Never touches data/ or real Zoho.
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "taskmanager-"));
process.env.TASKMANAGER_DATA = dir;
const { mirror, route, useConfig } = await import("./mirror");
afterAll(() => rmSync(dir, { recursive: true }));

const creds = { clientId: "1000.x", clientSecret: "s", refreshToken: "1000.r" };
useConfig({
  USERS: {
    me: { name: "Me", email: "me@example.com", dc: "zoho.com", ...creds },
    mideen: { name: "Mideen", email: "mideen@example.com", dc: "zoho.com" },
    anjali: { name: "Anjali", email: "anjali@example.com", dc: "zoho.com", clientId: "<id>", clientSecret: "<s>", refreshToken: "<t>" },
    arun: { name: "Arun", email: "arun@example.com", dc: "zoho.com" },
    madhavane: { name: "Madhavane", email: "madhavane@example.com", dc: "zoho.com" },
  },
  RULES: { caas: "mideen", daas: "anjali", people: "arun", zden: "madhavane" },
  SOURCE_PORTAL: "1", TARGET_PORTAL: "2", READER: "me",
});
const to = (o: Record<string, unknown>) => {
  const r = route({ id: "1", project: "CaaS", name: "T", tags: [], owners: [], ...o });
  return "skip" in r ? "skip" : r.person.key;
};

test("rules", () => {
  expect(to({})).toBe("mideen");
  expect(to({ project: "daas" })).toBe("anjali");
  expect(to({ project: "DaaS", tags: ["PEOPLE"] })).toBe("arun");
  expect(to({ tags: ["people"] })).toBe("mideen"); // people only counts in DaaS
  expect(to({ project: "DaaS", tags: ["people", "zDeN"] })).toBe("madhavane");
  expect(to({ tags: ["Internal", "zden"] })).toBe("skip");
  expect(to({ project: "Other" })).toBe("skip");
  expect(to({ project: "DaaS", tags: ["zden"], owners: ["MIDEEN@example.com"] })).toBe("mideen"); // assignee kept
  expect(to({ owners: ["someone@example.com"] })).toBe("mideen");
});

const real = globalThis.fetch;
afterEach(() => (globalThis.fetch = real));

test("placeholder credentials fall back to READER's token; assignee set; each task only once", async () => {
  const posts: any[] = [];
  globalThis.fetch = mock(async (url: any, init: any = {}) => {
    const u = String(url);
    if (u.startsWith("https://accounts.zoho.com/")) return Response.json({ access_token: "AT", expires_in: 3600 });
    if (u.endsWith("/portal/2/projects")) return Response.json([{ id: "7", name: "DaaS" }]);
    if (u.endsWith("/portal/2/projects/7/users")) return Response.json({ users: [{ id: "555", email: "Anjali@example.com" }] });
    if (u.endsWith("/portal/2/projects/7/tasks")) return posts.push({ auth: init.headers.Authorization, body: JSON.parse(init.body) }), Response.json({ tasks: [{ id: "t1", prefix: "DA1-T1" }] });
    return new Response("{}", { status: 404 });
  }) as any;
  const r = await mirror({ id: "s1", project: "DaaS", name: "Hello", description: "d", tags: [], owners: [] });
  expect(r).toMatchObject({ ok: true, target: "t1" });
  expect(posts).toEqual([{ auth: "Zoho-oauthtoken AT", body: { name: "Hello", description: "d", owners_and_work: { owners: [{ add: [{ zpuid: "555" }] }] } } }]);
  expect((await mirror({ id: "s1", project: "DaaS", name: "Hello", tags: [], owners: [] })).result).toMatch(/already handled/);
  expect(posts.length).toBe(1);
});

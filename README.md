# taskManager

Copies tasks from one Zoho Projects portal to another and assigns each copy to the right person.

- **Source:** a task created in the **CaaS** or **DaaS** project of the source portal.
- **Copy:** created in the target portal's project of the same name, with the same name and description.

It is a small [Bun](https://bun.sh) API with no other dependencies. Zoho Flow is not needed (see the last section).

## Files

| File | What |
|---|---|
| `config.ts` | **All settings and keys**: users, rules, portals, port, API key. The only file you normally edit. |
| `mirror.ts` | The rules and the Zoho API calls. |
| `server.ts` | The HTTP API and the every-minute poll. |
| `mirror.test.ts` | Tests (`bun test`). They never call real Zoho. |
| `data/state.json` | Which source tasks were already copied, and where. Delete an entry to copy that task again. |

`config.ts` holds real secrets: keep it `chmod 600` and never commit or share it. `.gitignore` already leaves it out.

## Run

```sh
cd ~/Downloads/taskManager
bun start          # API on http://127.0.0.1:8787, polls the source every 60 s
bun run check      # tests every token, project and assignee once, then exits
bun test           # unit tests
```

To keep it running after you close the terminal:

```sh
nohup bun start >> data/taskManager.log 2>&1 &
```

Stop it with `pkill -f "bun server.ts"`. After **any** change to `config.ts`, stop it and start it again.

## Rules

The first rule that matches decides. Tags and project names match in any case (ZDEN, zden, Zden …).

| # | When | Copy goes to |
|---|---|---|
| 1 | Tag **Internal** | Not copied |
| 2 | Already assigned to one of the people in `RULES` | That same person, in any project |
| 3 | Tag **ZDEN** | `RULES.zden` |
| 4 | DaaS with tag **people** | `RULES.people` |
| 5 | CaaS | `RULES.caas` |
| 6 | DaaS | `RULES.daas` |

Who the copy is **created by**:

- If the assignee has their own credentials in `config.ts`, the copy is created with their token, so Created By is them.
- If they don't, it is created with `READER`'s token, so Created By is the READER user.

A few more behaviours:

- Subtasks are not copied.
- Tasks that existed before the first poll of a project are left alone.
- Each task is copied once. A failed copy is retried at the next poll.

## Where to update things (`config.ts`)

### Adding the real users

1. For each of **mideen**, **anjali** and **arunpandi** in `USERS`, replace every `<...>` placeholder:
   - `email`: their login email. It must match their user in the **target** projects.
   - `dc`: the target data centre, e.g. `zoho.com`.
   - `clientId`, `clientSecret`, `refreshToken`: from a Self Client they create while signed in as themselves. Steps are below.

   If you leave a person's credentials as `<...>`, they are **assignee only**: their copies are created with READER's token and assigned to them.
2. For ZDEN, add **Madhavane** to `USERS` the same way, e.g. `madhavane: { name: "Yogeshwar Madhavane D", email: "...", dc: "zoho.com", ... }`.
3. Point `RULES` at them:
   ```ts
   caas: "mideen", daas: "anjali", people: "arunpandi", zden: "madhavane",
   ```
4. Set the portals, using the portal's URL name or numeric id:
   - `SOURCE_PORTAL`: the zoho.in portal.
   - `TARGET_PORTAL`: the zoho.com portal.

   Both must have projects named **CaaS** and **DaaS**.
5. Set `READER` to a user whose token can **see the source portal**. For zoho.in → zoho.com, that means adding a zoho.in user with credentials, e.g. `magesh_in: { ..., dc: "zoho.in" }`, and setting `READER = "magesh_in"`.
   - Any assignee without credentials is created with READER's token. So when READER is on zoho.in and the target is zoho.com, every assignee needs their own zoho.com credentials.
6. Restart, then run `bun run check`. Every line should say `OK`.

### Getting a refresh token (each person, once)

1. Go to `https://api-console.zoho.com` (or `.in` / `.eu` for that data centre) → **Self Client** → **Generate Code**.
   - Scope: `ZohoProjects.portals.READ,ZohoProjects.projects.READ,ZohoProjects.tasks.ALL,ZohoProjects.users.READ`
   - Duration: 10 minutes.
2. Within those 10 minutes, swap the code for a refresh token. Use the accounts host of the same data centre:
   ```sh
   curl -s -X POST https://accounts.zoho.com/oauth/v2/token \
     -d grant_type=authorization_code -d client_id=<id> -d client_secret=<secret> -d code=<code>
   ```
3. Copy `refresh_token` from the reply into `config.ts`. It doesn't expire unless revoked. Zoho allows about 20 refresh tokens per user and client; older ones stop working beyond that.

### Other settings

| Setting | Meaning |
|---|---|
| `POLL` / `POLL_SECONDS` | Turn the source check on or off, and set how often it runs. |
| `HOST` | `127.0.0.1` = this machine only. `0.0.0.0` = reachable from the network, which a webhook needs. |
| `PORT` | The port the API listens on. |
| `API_KEY` | Needed by callers of the protected endpoints below. Change it to any long random string. |

## API

| Method and path | Key | What |
|---|---|---|
| `GET /` or `GET /api/status` | none | Portals, rules, last poll, last error, recent copies. No secrets. |
| `GET /api/check` | `X-Api-Key` | Same as `bun run check`. |
| `POST /api/mirror` | `X-Api-Key` | Copies one task now. For a webhook, or for testing. |

Body of `POST /api/mirror`:

```json
{ "id": "<source task id>", "project": "CaaS", "name": "Task name", "description": "", "tags": ["zden"], "owners": ["someone@zohocorp.com"] }
```

Example:

```sh
curl -s -X POST http://127.0.0.1:8787/api/mirror -H "X-Api-Key: <API_KEY from config.ts>" \
  -H "Content-Type: application/json" -d '{"id":"test-1","project":"CaaS","name":"hello","tags":[],"owners":[]}'
```

## Current state (2026-10-21)

- **Test setup** in `config.ts`:
  - source `mageshdotkumarzohotestdotcom` → target `mageshdotkumart10zohotestdotcom` (localzoho);
  - one token (Magesh t10) for everything;
  - assignees: CaaS → Vignesh, DaaS → Deepika, people → Rahul, ZDEN → Magesh (t10).
- **Proven:** 4 real source tasks went through `POST /api/mirror` → t10 CA1-T10, CA1-T11, DA1-T1 and DA1-T2, each with the right owner. `data/state.json` remembers them, so they are not copied again.
- **Not yet working: automatic polling.** The t10 account is **not a member of the source portal**, so `source CaaS/DaaS` fails in `bun run check`.
  - Fix: invite `magesh.kumar+t10@zohotest.com` to `mageshdotkumarzohotestdotcom` and add it to CaaS and DaaS.
  - Until then, the log shows `poll failed: ... cannot see portal` once, and `POST /api/mirror` still works.

## Does Zoho Flow play any part?

**No.** taskManager notices new tasks itself, by polling with READER's token, and creates the copies through the Zoho Projects REST API. No Flow, Deluge function or Flow connection is involved.

- The earlier Flow **"ZoP Arunpandi to t10 Sync"** is switched **off** and can stay off or be deleted. Turning it back on would create a second copy of each source DaaS task.
- **"ZoP CaaS Task Sync"** is a separate, older flow that taskManager doesn't use or touch.
- Flow would only matter if you wanted instant copies instead of a copy within a minute. A Flow trigger could then call `POST /api/mirror`, but only once this API is reachable from Zoho's servers (public host, `HOST = "0.0.0.0"`).

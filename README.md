# ADO Sprint Analytics Dashboard

A dashboard for two Agile teams that manage work in Azure DevOps. You supply an ADO
**Personal Access Token (PAT)** in the UI; it is held in your browser's `sessionStorage`
for the tab's session and sent with each API request. The server stores **no** connection
state between requests, so concurrent users never share credentials or data.

## What it shows

- **Sprint switching** — choose Team + Iteration from the top bar; all analytics refresh for that sprint.
- **Team metrics** — elapsed/remaining sprint days, worked/burned/remaining hours, utilization,
  burn efficiency, scope added, tasks touched, active contributors.
- **Per-person metrics** — capacity, worked, burned, remaining, completed, utilization/burn efficiency,
  impeded, over/under, day-level activity, and tasks touched.
- **Daily hours per person** — a person × day grid for the sprint, with each day showing:
  - **W**: worked hours
  - **B**: burned hours
- **Team burndown** — remaining work hours per day, with an ideal guideline.
- **Out-of-sprint work watcher** — highlights tasks that had work logged during the sprint window
  but are currently assigned to a different iteration, including worked/burned hour rollups.
- **Per-person burndown** — every person on one chart as a distinct colored line, with a toggle
  between **Remaining work hours** and **Cumulative hours completed**.
- **Export** — CSV for metrics/tables, PNG for charts.

Impeded hours are derived from the sprint Taskboard API by finding tasks currently in the
`Impeded` column and summing their current `Remaining Work` by assignee.

## How hours are derived

Azure DevOps' native fields (`Completed Work` / `Remaining Work`) only store each Task's current
totals — not who logged what on which day. This app **reconstructs daily hours from each Task's
revision history**: every increase in *Completed Work* is attributed to the Task's assignee on the
date of that revision. This is a solid approximation. Caveats:

- Bulk edits or backfilled hours land on the edit date, not when the work happened.
- If a Task is reassigned, past deltas stay with whoever was assigned at the time of each revision.
- Times are bucketed by day in UTC.

## Credentials and multi-user safety

Every API request must carry its own credentials as headers:

| Header | Value |
| --- | --- |
| `X-ADO-Org` | organization name (or full `https://dev.azure.com/...` URL) |
| `X-ADO-Project` | project name |
| `X-ADO-PAT` | personal access token |

The server builds a fresh ADO client per request (`makeClient()` in `server/adoClient.js`)
and holds the PAT only in that call's closure. There is no module-level or global
connection state.

This matters for the Cloudflare deployment: a Worker isolate serves many concurrent
requests from different visitors and reuses its module scope between them. Storing the PAT
in a module-level variable would let one user's request read or overwrite another's
credentials. Per-request credentials remove that class of bug entirely.

`POST /api/connect` is a stateless validation ping — it verifies the supplied credentials
and returns the visible teams. It does not create a session. Disconnecting simply clears
the credentials in the browser.

**CORS is closed by default.** The client is served same-origin (or through the Vite dev
proxy), so no cross-origin access is required. To allow another origin, set a
comma-separated `ALLOWED_ORIGINS` (an env var for the Express server, a Worker var for
Cloudflare).

> **Note:** these headers authenticate to *Azure DevOps*, not to this app. A publicly
> reachable deployment is still an open proxy that anyone can point at their own ADO org.
> Put an access control layer (for example Cloudflare Access) in front of a public
> deployment.

## Prerequisites

- Node.js 18+ (tested on Node 23).
- An ADO PAT with **Work Items (Read)** and **Analytics (Read)** scopes.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:5173. The Vite dev server proxies API calls to the Express backend
on port 3001.

### Production-style single process

```bash
npm start
```

This builds the client and serves everything from http://localhost:3001.

### Cloudflare deploy (static assets)

This repo includes a `wrangler.toml` with:
- `assets.directory = "./client/dist"`
- a Worker entry (`worker.js`) that serves both static assets and `/api/*` routes.

Cloudflare Worker requests have subrequest limits. The worker API path applies a
conservative "limit mode" (caps revision-history tasks) to avoid invocation
failures on large sprints.

For large sprints, the client now uses chunked dashboard loading (`/api/dashboard-chunk`)
and merges results client-side so all tasks can be included without hitting per-invocation
subrequest caps. Outside-sprint watcher data is computed from the first chunk only
and "outside-sprint tasks worked" includes only tasks with positive worked hours
attributed to named users.

Build first, then deploy:

```bash
npm run build
npx wrangler deploy
```

## Configuration

Enter these in the UI:

- **Organization** — `my-org` or `https://dev.azure.com/my-org`
- **Project** — the ADO project that contains both teams
- **PAT** — see scopes above

Pick a **Team** and **Iteration** from the top bar. Data loads automatically; use **Refresh** to
re-pull. Switching team or iteration reloads.

## Project layout

```
server/
  index.js       Express app + routes + static hosting of the built client
  adoClient.js   Per-request ADO REST client factory (auth, teams, iterations, capacity, WIQL, revisions)
  aggregate.js   Sprint metric reconstruction (daily hours, team/person metrics, burndowns)
client/
  src/
    App.jsx                    Shell: connect, team/iteration pickers, analytics tabs, refresh
    components/                One component per view
    utils/exports.js           CSV + PNG export
    utils/colors.js            Per-person line colors
```

## Notes / assumptions

- Completed states default to `Done/Closed/Completed/Resolved`; removed states (`Removed/Cut`)
  are excluded from feature rollups.
- Story-point rollups treat `User Story` / `Product Backlog Item` / `Requirement` as the
  story-level item; hours come from `Task` items.
- The iteration must have **start and finish dates** set in ADO for burndown/daily-hours to work.

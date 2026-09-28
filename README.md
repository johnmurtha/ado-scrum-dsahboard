# ADO Sprint Analytics Dashboard

A local, single-user dashboard for two Agile teams that manage work in Azure DevOps.
Everything runs on your machine. You supply an ADO **Personal Access Token (PAT)** in the
UI; it is kept only in the local server's memory for the session and is never written to disk.

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
conservative "limit mode" (caps revision-history tasks and disables the outside-sprint
watcher) to avoid invocation failures on large sprints.

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
  adoClient.js   ADO REST client (auth, teams, iterations, capacity, WIQL, revisions)
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

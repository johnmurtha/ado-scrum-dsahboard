import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { clientFromHeaders } from './adoClient.js';
import { buildDashboard, buildFeatures } from './aggregate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();

// CORS is opt-in and closed by default. The client is served same-origin
// (production) or through the Vite dev proxy, so no cross-origin access is
// needed. Set ALLOWED_ORIGINS to a comma-separated allowlist only if you
// deliberately host the client on a different origin.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (allowedOrigins.length) {
  app.use(cors({
    origin: allowedOrigins,
    allowedHeaders: ['Content-Type', 'X-ADO-Org', 'X-ADO-Project', 'X-ADO-PAT'],
  }));
}

app.use(express.json());

// Credentials are per-request only; never log or cache them.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    // Log the status/message only -- never the request headers, which carry the PAT.
    console.error(`[api] ${req.method} ${req.path} -> ${err.status || 500}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'Internal error' });
  });
};

// Build an ADO client scoped to this request's credential headers.
const clientFor = (req) => clientFromHeaders((name) => req.get(name));

// --- API -----------------------------------------------------------------

// Stateless credential check. Returns the teams visible to the supplied PAT.
app.post('/api/connect', wrap(async (req, res) => {
  const client = clientFor(req);
  await client.validate(); // throws 401 on bad PAT/org/project
  const teams = await client.getTeams();
  res.json({ org: client.org, project: client.project, connected: true, teams });
}));

app.get('/api/teams', wrap(async (req, res) => {
  res.json({ teams: await clientFor(req).getTeams() });
}));

app.get('/api/iterations', wrap(async (req, res) => {
  const { team } = req.query;
  if (!team) return res.status(400).json({ error: 'team is required' });
  res.json({ iterations: await clientFor(req).getIterations(team) });
}));

app.get('/api/dashboard', wrap(async (req, res) => {
  const { team, iterationId } = req.query;
  if (!team || !iterationId) return res.status(400).json({ error: 'team and iterationId are required' });
  res.json(await buildDashboard(clientFor(req), team, iterationId));
}));

app.get('/api/dashboard-chunk', wrap(async (req, res) => {
  const { team, iterationId, offset, limit } = req.query;
  if (!team || !iterationId) return res.status(400).json({ error: 'team and iterationId are required' });
  const parsedOffset = Number.isFinite(Number(offset)) ? Number(offset) : 0;
  const parsedLimit = Number.isFinite(Number(limit)) ? Number(limit) : 25;
  res.json(await buildDashboard(clientFor(req), team, iterationId, {
    taskOffset: parsedOffset,
    taskLimit: parsedLimit,
    enableOffSprintWatch: true,
    maxOffSprintTasks: 10,
  }));
}));

app.get('/api/features', wrap(async (req, res) => {
  const { team, iterationId } = req.query;
  if (!team) return res.status(400).json({ error: 'team is required' });
  res.json(await buildFeatures(clientFor(req), team, iterationId || null));
}));

// --- static (production build) ------------------------------------------

// Unknown API routes must return JSON, not the SPA shell. This keeps stale
// clients (e.g. ones still calling the removed /api/status) from receiving
// HTML and failing with a confusing parse error.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

const dist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`\nADO Scrum Dashboard API running at http://localhost:${PORT}`);
  if (!fs.existsSync(dist)) {
    console.log('Dev mode: start the client with `npm run dev` (Vite on http://localhost:5173).');
  } else {
    console.log(`Open http://localhost:${PORT} in your browser.`);
  }
});

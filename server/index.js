import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import {
  setConfig,
  getConfig,
  clearConfig,
  validate,
  getTeams,
  getIterations,
} from './adoClient.js';
import { buildDashboard, buildFeatures } from './aggregate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Internal error' });
  });
};

// --- API -----------------------------------------------------------------

app.post('/api/connect', wrap(async (req, res) => {
  const { org, project, pat } = req.body || {};
  if (!org || !project || !pat) {
    return res.status(400).json({ error: 'org, project, and pat are required.' });
  }
  setConfig({ org, project, pat });
  await validate(); // throws 401 on bad PAT/org/project
  const teams = await getTeams();
  res.json({ ...getConfig(), teams });
}));

app.get('/api/status', wrap(async (req, res) => {
  res.json(getConfig());
}));

app.post('/api/disconnect', wrap(async (req, res) => {
  clearConfig();
  res.json({ connected: false });
}));

app.get('/api/teams', wrap(async (req, res) => {
  res.json({ teams: await getTeams() });
}));

app.get('/api/iterations', wrap(async (req, res) => {
  const { team } = req.query;
  if (!team) return res.status(400).json({ error: 'team is required' });
  res.json({ iterations: await getIterations(team) });
}));

app.get('/api/dashboard', wrap(async (req, res) => {
  const { team, iterationId } = req.query;
  if (!team || !iterationId) return res.status(400).json({ error: 'team and iterationId are required' });
  res.json(await buildDashboard(team, iterationId));
}));

app.get('/api/features', wrap(async (req, res) => {
  const { team, iterationId } = req.query;
  if (!team) return res.status(400).json({ error: 'team is required' });
  res.json(await buildFeatures(team, iterationId || null));
}));

// --- static (production build) ------------------------------------------

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

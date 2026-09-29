import {
  setConfig,
  getConfig,
  clearConfig,
  validate,
  getTeams,
  getIterations,
} from './server/adoClient.js';
import { buildDashboard, buildFeatures } from './server/aggregate.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function errorResponse(err) {
  const status = err?.status || 500;
  const message = err?.message || 'Internal error';
  return json({ error: message }, status);
}

async function handleApi(request, url) {
  const method = request.method.toUpperCase();
  const path = url.pathname;

  if (method === 'POST' && path === '/api/connect') {
    const body = await readJson(request);
    const { org, project, pat } = body || {};
    if (!org || !project || !pat) return json({ error: 'org, project, and pat are required.' }, 400);
    setConfig({ org, project, pat });
    await validate();
    const teams = await getTeams();
    return json({ ...getConfig(), teams });
  }

  if (method === 'GET' && path === '/api/status') {
    return json(getConfig());
  }

  if (method === 'POST' && path === '/api/disconnect') {
    clearConfig();
    return json({ connected: false });
  }

  if (method === 'GET' && path === '/api/teams') {
    return json({ teams: await getTeams() });
  }

  if (method === 'GET' && path === '/api/iterations') {
    const team = url.searchParams.get('team');
    if (!team) return json({ error: 'team is required' }, 400);
    return json({ iterations: await getIterations(team) });
  }

  if (method === 'GET' && path === '/api/dashboard') {
    const team = url.searchParams.get('team');
    const iterationId = url.searchParams.get('iterationId');
    if (!team || !iterationId) return json({ error: 'team and iterationId are required' }, 400);
    return json(await buildDashboard(team, iterationId, {
      maxTasksForRevisions: 25,
      enableOffSprintWatch: false,
    }));
  }

  if (method === 'GET' && path === '/api/dashboard-chunk') {
    const team = url.searchParams.get('team');
    const iterationId = url.searchParams.get('iterationId');
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || 20);
    if (!team || !iterationId) return json({ error: 'team and iterationId are required' }, 400);
    return json(await buildDashboard(team, iterationId, {
      taskOffset: Number.isFinite(offset) ? offset : 0,
      taskLimit: Number.isFinite(limit) ? limit : 20,
      enableOffSprintWatch: true,
      maxTasksForRevisions: Infinity,
      maxOffSprintTasks: 40,
    }));
  }

  if (method === 'GET' && path === '/api/features') {
    const team = url.searchParams.get('team');
    const iterationId = url.searchParams.get('iterationId');
    if (!team) return json({ error: 'team is required' }, 400);
    return json(await buildFeatures(team, iterationId || null));
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(request, url);
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      return errorResponse(err);
    }
  },
};

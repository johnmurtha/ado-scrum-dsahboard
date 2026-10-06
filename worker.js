import { clientFromHeaders } from './server/adoClient.js';
import { buildDashboard, buildFeatures } from './server/aggregate.js';

// CORS is closed by default. The client is served from the same Worker origin,
// so cross-origin access is unnecessary. Set an ALLOWED_ORIGINS var (comma
// separated) only if you deliberately host the client elsewhere.
function corsHeaders(request, env) {
  const allowed = (env?.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get('origin');
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'Content-Type, X-ADO-Org, X-ADO-Project, X-ADO-PAT',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    vary: 'Origin',
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

function errorResponse(err, extraHeaders = {}) {
  const status = err?.status || 500;
  const message = err?.message || 'Internal error';
  return json({ error: message }, status, extraHeaders);
}

// Build an ADO client scoped to this request's credential headers.
const clientFor = (request) => clientFromHeaders((name) => request.headers.get(name));

async function handleApi(request, url) {
  const method = request.method.toUpperCase();
  const path = url.pathname;

  // Stateless credential check. Returns the teams visible to the supplied PAT.
  if (method === 'POST' && path === '/api/connect') {
    const client = clientFor(request);
    await client.validate();
    const teams = await client.getTeams();
    return json({ org: client.org, project: client.project, connected: true, teams });
  }

  if (method === 'GET' && path === '/api/teams') {
    return json({ teams: await clientFor(request).getTeams() });
  }

  if (method === 'GET' && path === '/api/iterations') {
    const team = url.searchParams.get('team');
    if (!team) return json({ error: 'team is required' }, 400);
    return json({ iterations: await clientFor(request).getIterations(team) });
  }

  if (method === 'GET' && path === '/api/dashboard') {
    const team = url.searchParams.get('team');
    const iterationId = url.searchParams.get('iterationId');
    if (!team || !iterationId) return json({ error: 'team and iterationId are required' }, 400);
    return json(await buildDashboard(clientFor(request), team, iterationId, {
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
    return json(await buildDashboard(clientFor(request), team, iterationId, {
      taskOffset: Number.isFinite(offset) ? offset : 0,
      taskLimit: Number.isFinite(limit) ? limit : 20,
      enableOffSprintWatch: true,
      maxTasksForRevisions: Infinity,
      maxOffSprintTasks: 10,
    }));
  }

  if (method === 'GET' && path === '/api/features') {
    const team = url.searchParams.get('team');
    const iterationId = url.searchParams.get('iterationId');
    if (!team) return json({ error: 'team is required' }, 400);
    return json(await buildFeatures(clientFor(request), team, iterationId || null));
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    try {
      if (url.pathname.startsWith('/api/')) {
        if (request.method.toUpperCase() === 'OPTIONS') {
          return new Response(null, { status: 204, headers: cors });
        }
        const res = await handleApi(request, url);
        if (Object.keys(cors).length) {
          const merged = new Headers(res.headers);
          for (const [k, v] of Object.entries(cors)) merged.set(k, v);
          return new Response(res.body, { status: res.status, headers: merged });
        }
        return res;
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      return errorResponse(err, cors);
    }
  },
};

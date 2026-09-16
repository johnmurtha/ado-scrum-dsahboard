// Tiny fetch wrapper for the local API.
async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  connect: (cfg) => call('POST', '/api/connect', cfg),
  status: () => call('GET', '/api/status'),
  disconnect: () => call('POST', '/api/disconnect'),
  teams: () => call('GET', '/api/teams'),
  iterations: (team) => call('GET', `/api/iterations?team=${encodeURIComponent(team)}`),
  dashboard: (team, iterationId) =>
    call('GET', `/api/dashboard?team=${encodeURIComponent(team)}&iterationId=${encodeURIComponent(iterationId)}`),
  features: (team, iterationId) =>
    call('GET', `/api/features?team=${encodeURIComponent(team)}${iterationId ? `&iterationId=${encodeURIComponent(iterationId)}` : ''}`),
};

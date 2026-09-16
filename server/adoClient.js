// Thin Azure DevOps REST client. Holds connection config in memory only
// (PAT is never written to disk). All calls use Basic auth with the PAT.

const API = '7.1';

let config = { org: null, project: null, pat: null };

export function setConfig({ org, project, pat }) {
  // Accept either a bare org name or a full URL and normalize to the org name.
  let o = (org || '').trim();
  const m = o.match(/dev\.azure\.com\/([^/]+)/i);
  if (m) o = m[1];
  o = o.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  config = { org: o, project: (project || '').trim(), pat: (pat || '').trim() };
}

export function getConfig() {
  return { org: config.org, project: config.project, connected: !!config.pat };
}

export function clearConfig() {
  config = { org: null, project: null, pat: null };
}

function authHeader() {
  const token = Buffer.from(`:${config.pat}`).toString('base64');
  return `Basic ${token}`;
}

function assertConnected() {
  if (!config.pat || !config.org || !config.project) {
    const err = new Error('Not connected. Provide organization, project, and PAT first.');
    err.status = 401;
    throw err;
  }
}

async function req(method, url, body) {
  assertConnected();
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text).message || text;
    } catch {
      /* keep raw text */
    }
    const err = new Error(`ADO ${res.status}: ${detail}`.slice(0, 500));
    err.status = res.status === 401 || res.status === 203 ? 401 : res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

const orgBase = () => `https://dev.azure.com/${config.org}`;
const projBase = () => `${orgBase()}/${encodeURIComponent(config.project)}`;
const teamBase = (team) => `${projBase()}/${encodeURIComponent(team)}`;

// --- Validation / discovery ---------------------------------------------

export async function validate() {
  // Cheapest call that proves org+project+PAT are valid.
  return req('GET', `${projBase()}/_apis/teams?api-version=${API}`).catch(() =>
    req('GET', `${orgBase()}/_apis/projects/${encodeURIComponent(config.project)}/teams?api-version=${API}`),
  );
}

export async function getTeams() {
  // Prefer teams the authenticated user is actually a member of (mine=true),
  // then narrow to the current project. Fall back to all project teams if the
  // org-level endpoint isn't available.
  const proj = (config.project || '').toLowerCase();
  try {
    const data = await req('GET', `${orgBase()}/_apis/teams?mine=true&api-version=${API}-preview.3`);
    const all = data.value || [];
    console.log(`[teams] mine=true returned ${all.length} team(s):`,
      all.map((t) => `${t.name} [proj=${t.projectName || t.projectId}]`).join('; '));
    const mine = all.filter(
      (t) => (t.projectName || '').toLowerCase() === proj || (t.projectId || '').toLowerCase() === proj,
    );
    console.log(`[teams] after project filter ("${config.project}"): ${mine.length} team(s)`);
    if (mine.length) return sortByName(mine.map((t) => ({ id: t.id, name: t.name })));
    console.log('[teams] no "mine" teams matched the project; falling back to ALL project teams');
  } catch (e) {
    console.log(`[teams] mine=true endpoint failed (${e.message}); falling back to ALL project teams`);
  }
  const data = await req(
    'GET',
    `${orgBase()}/_apis/projects/${encodeURIComponent(config.project)}/teams?api-version=${API}`,
  );
  return sortByName((data.value || []).map((t) => ({ id: t.id, name: t.name })));
}

function sortByName(teams) {
  return teams.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export async function getIterations(team) {
  const data = await req('GET', `${teamBase(team)}/_apis/work/teamsettings/iterations?api-version=${API}`);
  return (data.value || []).map((it) => ({
    id: it.id,
    name: it.name,
    path: it.path,
    startDate: it.attributes?.startDate || null,
    finishDate: it.attributes?.finishDate || null,
    timeFrame: it.attributes?.timeFrame || null,
  }));
}

export async function getTeamSettings(team) {
  // workingDays is an array like ["monday","tuesday",...].
  return req('GET', `${teamBase(team)}/_apis/work/teamsettings?api-version=${API}`);
}

export async function getTeamFieldValues(team) {
  // The area path(s) that define which work items belong to this team.
  // Returns { field: 'System.AreaPath', defaultValue, values: [{ value, includeChildren }] }.
  const data = await req('GET', `${teamBase(team)}/_apis/work/teamsettings/teamfieldvalues?api-version=${API}`);
  return {
    field: data.field?.referenceName || 'System.AreaPath',
    defaultValue: data.defaultValue || null,
    values: data.values || [],
  };
}

export async function getCapacities(team, iterationId) {
  // Per-team-member capacity (hours/day per activity) for the iteration.
  const data = await req(
    'GET',
    `${teamBase(team)}/_apis/work/teamsettings/iterations/${iterationId}/capacities?api-version=${API}`,
  );
  // Different API versions wrap the list as `value` or `teamMembers`.
  const list = data.value || data.teamMembers || [];
  console.log(`[capacities] team="${team}" iteration=${iterationId} returned ${list.length} member record(s)`);
  return list;
}

export async function getTeamDaysOff(team, iterationId) {
  const data = await req(
    'GET',
    `${teamBase(team)}/_apis/work/teamsettings/iterations/${iterationId}/teamdaysoff?api-version=${API}`,
  );
  return data.daysOff || [];
}

// --- Work items ----------------------------------------------------------

export async function wiql(query) {
  return req('POST', `${projBase()}/_apis/wit/wiql?api-version=${API}`, { query });
}

export async function getWorkItemsBatch(ids, fields) {
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const data = await req('POST', `${orgBase()}/_apis/wit/workitemsbatch?api-version=${API}`, {
      ids: chunk,
      fields,
    });
    out.push(...(data.value || []));
  }
  return out;
}

export async function getRevisions(id) {
  const out = [];
  let skip = 0;
  const top = 200;
  // Paged revisions in chronological order.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await req(
      'GET',
      `${projBase()}/_apis/wit/workItems/${id}/revisions?$top=${top}&$skip=${skip}&api-version=${API}`,
    );
    const batch = data.value || [];
    out.push(...batch);
    if (batch.length < top) break;
    skip += top;
  }
  return out;
}

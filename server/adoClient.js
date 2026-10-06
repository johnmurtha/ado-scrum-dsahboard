// Thin Azure DevOps REST client.
//
// Credentials are NEVER stored in module-level state. Every request builds its
// own client via `makeClient()`, so concurrent requests (including those served
// by the same warm Cloudflare Worker isolate) can never observe or overwrite
// each other's PAT, organization, or project.

const API = '7.1';

// Accept either a bare org name or a full URL and normalize to the org name.
export function normalizeOrg(org) {
  let o = (org || '').trim();
  const m = o.match(/dev\.azure\.com\/([^/]+)/i);
  if (m) o = m[1];
  return o.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function base64(input) {
  if (typeof btoa === 'function') return btoa(input);
  return Buffer.from(input, 'binary').toString('base64');
}

export function unauthorized(message = 'Not connected. Provide organization, project, and PAT first.') {
  const err = new Error(message);
  err.status = 401;
  return err;
}

/**
 * Build an ADO client bound to a single set of credentials.
 * The PAT lives only in this closure for the lifetime of the request.
 */
export function makeClient({ org, project, pat } = {}) {
  const o = normalizeOrg(org);
  const p = (project || '').trim();
  const token = (pat || '').trim();

  if (!o || !p || !token) throw unauthorized();

  const authHeader = `Basic ${base64(`:${token}`)}`;
  const orgBase = () => `https://dev.azure.com/${o}`;
  const projBase = () => `${orgBase()}/${encodeURIComponent(p)}`;
  const teamBase = (team) => `${projBase()}/${encodeURIComponent(team)}`;

  async function req(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: authHeader,
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

  function sortByName(teams) {
    return teams.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  // --- Validation / discovery -------------------------------------------

  async function validate() {
    // Cheapest call that proves org+project+PAT are valid.
    return req('GET', `${projBase()}/_apis/teams?api-version=${API}`).catch(() =>
      req('GET', `${orgBase()}/_apis/projects/${encodeURIComponent(p)}/teams?api-version=${API}`),
    );
  }

  async function getTeams() {
    // Prefer teams the authenticated user is actually a member of (mine=true),
    // then narrow to the current project. Fall back to all project teams if the
    // org-level endpoint isn't available.
    const proj = p.toLowerCase();
    try {
      const data = await req('GET', `${orgBase()}/_apis/teams?mine=true&api-version=${API}-preview.3`);
      const all = data.value || [];
      const mine = all.filter(
        (t) => (t.projectName || '').toLowerCase() === proj || (t.projectId || '').toLowerCase() === proj,
      );
      if (mine.length) return sortByName(mine.map((t) => ({ id: t.id, name: t.name })));
    } catch {
      /* fall through to all project teams */
    }
    const data = await req(
      'GET',
      `${orgBase()}/_apis/projects/${encodeURIComponent(p)}/teams?api-version=${API}`,
    );
    return sortByName((data.value || []).map((t) => ({ id: t.id, name: t.name })));
  }

  async function getIterations(team) {
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

  async function getTeamSettings(team) {
    // workingDays is an array like ["monday","tuesday",...].
    return req('GET', `${teamBase(team)}/_apis/work/teamsettings?api-version=${API}`);
  }

  async function getTeamFieldValues(team) {
    // The area path(s) that define which work items belong to this team.
    // Returns { field: 'System.AreaPath', defaultValue, values: [{ value, includeChildren }] }.
    const data = await req('GET', `${teamBase(team)}/_apis/work/teamsettings/teamfieldvalues?api-version=${API}`);
    return {
      field: data.field?.referenceName || 'System.AreaPath',
      defaultValue: data.defaultValue || null,
      values: data.values || [],
    };
  }

  async function getCapacities(team, iterationId) {
    // Per-team-member capacity (hours/day per activity) for the iteration.
    const data = await req(
      'GET',
      `${teamBase(team)}/_apis/work/teamsettings/iterations/${iterationId}/capacities?api-version=${API}`,
    );
    // Different API versions wrap the list as `value` or `teamMembers`.
    return data.value || data.teamMembers || [];
  }

  async function getTeamDaysOff(team, iterationId) {
    const data = await req(
      'GET',
      `${teamBase(team)}/_apis/work/teamsettings/iterations/${iterationId}/teamdaysoff?api-version=${API}`,
    );
    return data.daysOff || [];
  }

  async function getTaskboardWorkItems(team, iterationId) {
    const data = await req(
      'GET',
      `${teamBase(team)}/_apis/work/taskboardworkitems/${iterationId}?api-version=${API}`,
    );
    return Array.isArray(data) ? data : (data.value || []);
  }

  // --- Work items --------------------------------------------------------

  async function wiql(query) {
    return req('POST', `${projBase()}/_apis/wit/wiql?api-version=${API}`, { query });
  }

  async function getWorkItemsBatch(ids, fields) {
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

  async function getRevisions(id) {
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

  return {
    org: o,
    project: p,
    validate,
    getTeams,
    getIterations,
    getTeamSettings,
    getTeamFieldValues,
    getCapacities,
    getTeamDaysOff,
    getTaskboardWorkItems,
    wiql,
    getWorkItemsBatch,
    getRevisions,
  };
}

/**
 * Build a client from the per-request credential headers.
 * `getHeader` receives a lowercase header name and returns its value.
 */
export function clientFromHeaders(getHeader) {
  return makeClient({
    org: getHeader('x-ado-org'),
    project: getHeader('x-ado-project'),
    pat: getHeader('x-ado-pat'),
  });
}

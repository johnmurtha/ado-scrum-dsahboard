// Tiny fetch wrapper for the local API.
async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : null);

function mergeActivity(into, add) {
  for (const [person, days] of Object.entries(add || {})) {
    into[person] ||= {};
    for (const [day, items] of Object.entries(days || {})) {
      into[person][day] ||= {};
      for (const it of items || []) {
        const key = String(it.id);
        if (!into[person][day][key]) into[person][day][key] = { ...it, worked: 0, burned: 0 };
        into[person][day][key].worked = round(into[person][day][key].worked + (it.worked || 0));
        into[person][day][key].burned = round(into[person][day][key].burned + (it.burned || 0));
      }
    }
  }
}

function normalizeActivity(map) {
  return Object.fromEntries(
    Object.entries(map).map(([person, days]) => ([
      person,
      Object.fromEntries(
        Object.entries(days).map(([day, byId]) => ([
          day,
          Object.values(byId)
            .filter((it) => it.worked > 0 || it.burned > 0)
            .sort((a, b) => (b.worked + b.burned) - (a.worked + a.burned)),
        ])),
      ),
    ])),
  );
}

function mergeDashboardChunks(chunks) {
  const first = chunks[0];
  const days = first.workingDays || [];
  const today = new Date().toISOString().slice(0, 10);
  const asOfDay = first.teamMetrics?.generatedThrough
    || [...days].reverse().find((d) => d <= today)
    || null;
  const asOfIndex = asOfDay ? days.indexOf(asOfDay) : -1;

  const people = {};
  const impededByPerson = {};
  const touchesByPerson = {};
  const teamByDay = {};
  const personRemainingByDay = {};
  const activityMap = {};
  const offSprintActivityMap = {};
  let scopeAddedToDate = 0;
  let scopeRemovedToDate = 0;

  const ensurePerson = (name, capacityPerDay = 0, daysOff = []) => {
    if (!people[name]) {
      people[name] = { name, capacityPerDay, daysOff, cells: Object.fromEntries(days.map((d) => [d, { day: d, worked: 0, burned: 0, capacity: 0, off: false }])) };
    }
    return people[name];
  };

  for (const c of chunks) {
    scopeAddedToDate += c.teamMetrics?.scopeAddedToDate || 0;
    scopeRemovedToDate += c.teamMetrics?.scopeRemovedToDate || 0;
    for (const p of c.dailyHours?.people || []) {
      const row = ensurePerson(p.name, p.capacityPerDay, p.daysOff || []);
      row.capacityPerDay = Math.max(row.capacityPerDay || 0, p.capacityPerDay || 0);
      for (const cell of p.cells || []) {
        const t = row.cells[cell.day];
        if (!t) continue;
        t.worked = round(t.worked + (cell.worked || 0));
        t.burned = round(t.burned + (cell.burned || 0));
        if (!t.capacity) t.capacity = cell.capacity || 0;
        t.off = t.off || !!cell.off;
      }
    }

    for (const p of c.personMetrics || []) {
      impededByPerson[p.name] = round((impededByPerson[p.name] || 0) + (p.impededToday || 0));
      touchesByPerson[p.name] = (touchesByPerson[p.name] || 0) + (p.tasksTouched || 0);
    }

    for (const d of c.burndown?.team || []) {
      teamByDay[d.day] ||= { remaining: 0, unassigned: 0, hadRemaining: false, hadUnassigned: false };
      if (d.remaining != null) {
        teamByDay[d.day].remaining = round(teamByDay[d.day].remaining + d.remaining);
        teamByDay[d.day].hadRemaining = true;
      }
      if (d.unassigned != null) {
        teamByDay[d.day].unassigned = round(teamByDay[d.day].unassigned + d.unassigned);
        teamByDay[d.day].hadUnassigned = true;
      }
    }

    for (const p of c.burndown?.people || []) {
      personRemainingByDay[p.name] ||= {};
      for (const pt of p.remaining || []) {
        if (pt.hours == null) continue;
        personRemainingByDay[p.name][pt.day] = round((personRemainingByDay[p.name][pt.day] || 0) + pt.hours);
      }
    }

    mergeActivity(activityMap, c.personDayTaskActivity || {});
    mergeActivity(offSprintActivityMap, c.offSprintDayTaskActivity || {});
  }

  const personList = Object.values(people).sort((a, b) => a.name.localeCompare(b.name));
  const dailyHours = {
    days,
    people: personList.map((p) => {
      const cells = days.map((d) => p.cells[d]);
      return {
        name: p.name,
        capacityPerDay: p.capacityPerDay,
        daysOff: p.daysOff,
        cells,
        totalWorked: round(cells.reduce((s, x) => s + x.worked, 0)),
        totalBurned: round(cells.reduce((s, x) => s + x.burned, 0)),
        totalCapacity: round(cells.reduce((s, x) => s + x.capacity, 0)),
      };
    }),
  };

  const burndownTeam = days.map((day) => ({
    day,
    remaining: teamByDay[day]?.hadRemaining ? round(teamByDay[day].remaining) : null,
    unassigned: teamByDay[day]?.hadUnassigned ? round(teamByDay[day].unassigned) : null,
  }));
  const startRemaining = burndownTeam[0]?.remaining || 0;
  burndownTeam.forEach((d, i) => {
    d.ideal = round(startRemaining * (1 - i / Math.max(1, burndownTeam.length - 1)));
  });

  const burndownPeople = personList.map((p) => {
    let cum = 0;
    const remaining = [];
    const completed = [];
    for (let i = 0; i < days.length; i += 1) {
      const day = days[i];
      const worked = p.cells[day]?.worked || 0;
      if (asOfIndex >= 0 && i > asOfIndex) {
        remaining.push({ day, hours: null });
        completed.push({ day, hours: null });
      } else {
        cum = round(cum + worked);
        remaining.push({ day, hours: round(personRemainingByDay[p.name]?.[day] || 0) });
        completed.push({ day, hours: cum });
      }
    }
    return { name: p.name, capacityPerDay: p.capacityPerDay || 0, remaining, completed };
  });

  const personMetrics = personList
    .map((p) => {
      const cellsToDate = p.cells && days.filter((d) => !asOfDay || d <= asOfDay).map((d) => p.cells[d]);
      const workedToDate = round((cellsToDate || []).reduce((s, c) => s + c.worked, 0));
      const burnedToDate = round((cellsToDate || []).reduce((s, c) => s + c.burned, 0));
      const capacityToDate = round((cellsToDate || []).reduce((s, c) => s + c.capacity, 0));
      const remainingToday = asOfDay ? round(personRemainingByDay[p.name]?.[asOfDay] || 0) : 0;
      const completedToDate = asOfDay
        ? round(burndownPeople.find((bp) => bp.name === p.name)?.completed.find((x) => x.day === asOfDay)?.hours || 0)
        : 0;
      const workedDays = (cellsToDate || []).filter((c) => c.worked > 0).length;
      const burnedDays = (cellsToDate || []).filter((c) => c.burned > 0).length;
      const elapsedWorkingDays = Math.max(1, (cellsToDate || []).length);
      return {
        name: p.name,
        capacityPerDay: round(p.capacityPerDay || 0),
        workedToDate,
        burnedToDate,
        completedToDate,
        impededToday: round(impededByPerson[p.name] || 0),
        remainingToday,
        capacityToDate,
        utilizationPct: pct(workedToDate, capacityToDate),
        burnEfficiencyPct: pct(burnedToDate, workedToDate),
        workedDays,
        burnedDays,
        avgWorkedPerDay: round(workedToDate / elapsedWorkingDays),
        avgBurnedPerDay: round(burnedToDate / elapsedWorkingDays),
        overUnderToDate: round(workedToDate - capacityToDate),
        tasksTouched: touchesByPerson[p.name] || 0,
      };
    })
    .filter((p) => p.capacityPerDay > 0 || p.workedToDate > 0 || p.burnedToDate > 0 || p.remainingToday > 0)
    .sort((a, b) => (b.burnedToDate - a.burnedToDate) || a.name.localeCompare(b.name));

  const teamWorkedToDate = round(personMetrics.reduce((s, p) => s + p.workedToDate, 0));
  const teamBurnedToDate = round(personMetrics.reduce((s, p) => s + p.burnedToDate, 0));
  const teamCapacityToDate = round(personMetrics.reduce((s, p) => s + p.capacityToDate, 0));
  const teamMetrics = {
    elapsedWorkingDays: Math.max(0, days.filter((d) => !asOfDay || d <= asOfDay).length),
    totalWorkingDays: days.length,
    remainingWorkingDays: Math.max(0, days.filter((d) => asOfDay && d > asOfDay).length),
    contributorsActive: personMetrics.filter((p) => p.workedToDate > 0 || p.burnedToDate > 0).length,
    taskCount: first.taskCount || 0,
    tasksTouchedCount: personMetrics.reduce((s, p) => s + (p.tasksTouched || 0), 0),
    workedToDate: teamWorkedToDate,
    burnedToDate: teamBurnedToDate,
    remainingToday: asOfDay ? round(teamByDay[asOfDay]?.remaining || 0) : null,
    capacityToDate: teamCapacityToDate,
    utilizationPct: pct(teamWorkedToDate, teamCapacityToDate),
    burnEfficiencyPct: pct(teamBurnedToDate, teamWorkedToDate),
    scopeAddedToDate: round(scopeAddedToDate),
    scopeRemovedToDate: round(scopeRemovedToDate),
    generatedThrough: asOfDay,
  };

  const warnings = Array.from(new Set([...(first.warnings || []), `Cloud chunk mode: merged ${chunks.length} request(s).`]));
  return {
    iteration: first.iteration,
    workingDays: days,
    dailyHours,
    capacityDiag: first.capacityDiag,
    storyPoints: first.storyPoints,
    teamMetrics,
    personMetrics,
    personDayTaskActivity: normalizeActivity(activityMap),
    offSprintDayTaskActivity: normalizeActivity(offSprintActivityMap),
    offSprintWork: first.offSprintWork || {},
    burndown: {
      team: burndownTeam,
      people: burndownPeople,
    },
    taskCount: first.taskCount,
    revisionsTaskCount: chunks.reduce((s, c) => s + (c.revisionsTaskCount || 0), 0),
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

async function loadDashboardChunked(team, iterationId, onProgress) {
  let limit = 20;
  let offset = 0;
  const chunks = [];
  let batch = 1;
  const report = (stage, loaded, total) => {
    if (typeof onProgress === 'function') onProgress({ stage, batch, loaded, total });
  };
  report('start', 0, null);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let c;
    try {
      c = await call(
        'GET',
        `/api/dashboard-chunk?team=${encodeURIComponent(team)}&iterationId=${encodeURIComponent(iterationId)}&offset=${offset}&limit=${limit}`,
      );
    } catch (err) {
      if (limit > 5) {
        const nextLimit = Math.max(5, Math.floor(limit / 2));
        // eslint-disable-next-line no-console
        console.warn(`[dashboard chunk] batch failed at offset ${offset} (limit=${limit}): ${err.message}. Retrying with limit=${nextLimit}.`);
        limit = nextLimit;
        report('retry', offset, null);
        continue;
      }
      throw err;
    }
    chunks.push(c);
    const start = Number.isFinite(c?.chunk?.offset) ? c.chunk.offset + 1 : offset + 1;
    const end = Number.isFinite(c?.chunk?.nextOffset) ? c.chunk.nextOffset : (offset + limit);
    const total = c?.taskCount ?? 'unknown';
    // Keep noisy diagnostics out of UI; surface progress in devtools.
    // eslint-disable-next-line no-console
    console.info(`[dashboard chunk] batch ${batch}: tasks ${start}-${Math.min(end, total)} of ${total}`);
    report('loading', Math.min(end, Number.isFinite(c?.taskCount) ? c.taskCount : end), c?.taskCount ?? null);
    batch += 1;
    if (!c?.chunk?.hasMore) break;
    offset = c.chunk.nextOffset;
  }
  report('merging', chunks[0]?.taskCount ?? null, chunks[0]?.taskCount ?? null);
  return mergeDashboardChunks(chunks);
}

export const api = {
  connect: (cfg) => call('POST', '/api/connect', cfg),
  status: () => call('GET', '/api/status'),
  disconnect: () => call('POST', '/api/disconnect'),
  teams: () => call('GET', '/api/teams'),
  iterations: (team) => call('GET', `/api/iterations?team=${encodeURIComponent(team)}`),
  dashboard: async (team, iterationId, onProgress) => {
    try {
      return await loadDashboardChunked(team, iterationId, onProgress);
    } catch (err) {
      if (err?.status === 404) {
        return call('GET', `/api/dashboard?team=${encodeURIComponent(team)}&iterationId=${encodeURIComponent(iterationId)}`);
      }
      throw err;
    }
  },
  features: (team, iterationId) =>
    call('GET', `/api/features?team=${encodeURIComponent(team)}${iterationId ? `&iterationId=${encodeURIComponent(iterationId)}` : ''}`),
};

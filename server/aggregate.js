// Aggregation logic: turns raw ADO work items + revision history into the
// metrics the dashboard needs. Hours are reconstructed from native
// Completed/Remaining Work fields via each Task's revision history.

// All ADO access goes through a per-request `client` built by
// `makeClient()` in adoClient.js. Nothing here touches shared/global
// credential state, so concurrent requests stay fully isolated.

const F = {
  type: 'System.WorkItemType',
  state: 'System.State',
  title: 'System.Title',
  assignedTo: 'System.AssignedTo',
  iterationPath: 'System.IterationPath',
  parent: 'System.Parent',
  completed: 'Microsoft.VSTS.Scheduling.CompletedWork',
  remaining: 'Microsoft.VSTS.Scheduling.RemainingWork',
  storyPoints: 'Microsoft.VSTS.Scheduling.StoryPoints',
  targetDate: 'Microsoft.VSTS.Scheduling.TargetDate',
  changedDate: 'System.ChangedDate',
  stackRank: 'Microsoft.VSTS.Common.StackRank',
  backlogPriority: 'Microsoft.VSTS.Common.BacklogPriority',
  priority: 'Microsoft.VSTS.Common.Priority',
  areaPath: 'System.AreaPath',
};

const COMPLETED_STATES = new Set(['done', 'closed', 'completed', 'resolved']);
const REMOVED_STATES = new Set(['removed', 'cut']);
const STORY_TYPES = new Set(['user story', 'product backlog item', 'requirement']);

const DAY_MS = 24 * 60 * 60 * 1000;
// An impeded task counts as stale once it has gone MORE than this many
// business days without any edit to the work item.
const DEFAULT_STALE_IMPEDIMENT_DAYS = 1;

// Elapsed time between two instants, in business days (fractional), skipping
// any UTC calendar day for which isWorkingDay(key) is false (weekends, team
// days off). Elapsed-time based so an edit an hour ago never reads as a day old.
function businessDaysBetween(fromMs, toMs, isWorkingDay) {
  if (!(toMs > fromMs)) return 0;
  let total = 0;
  let cursor = Math.floor(fromMs / DAY_MS) * DAY_MS;
  while (cursor < toMs) {
    const next = cursor + DAY_MS;
    const overlap = Math.min(next, toMs) - Math.max(cursor, fromMs);
    if (overlap > 0 && isWorkingDay(new Date(cursor).toISOString().slice(0, 10))) total += overlap;
    cursor = next;
  }
  return total / DAY_MS;
}

// --- helpers -------------------------------------------------------------

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function dateKey(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function personName(assignedTo) {
  if (!assignedTo) return 'Unassigned';
  if (typeof assignedTo === 'string') return assignedTo.split('<')[0].trim() || 'Unassigned';
  return assignedTo.displayName || 'Unassigned';
}

function isUnassignedPerson(name) {
  return String(name || '').trim().toLowerCase() === 'unassigned';
}

function num(v) {
  if (typeof v === 'number') return Number.isNaN(v) ? 0 : v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

function isImpededColumn(v) {
  return String(v || '').trim().toLowerCase() === 'impeded';
}

function taskboardColumn(item) {
  return item?.column || item?.boardColumn || item?.fields?.column || item?.fields?.boardColumn || '';
}

function taskboardId(item) {
  const id = item?.id || item?.workItemId || item?.workItem?.id || item?.targetId || item?.workItem?.targetId;
  return Number(id) || null;
}

function enumerateDays(start, finish) {
  const days = [];
  const d = new Date(dateKey(start) + 'T00:00:00.000Z');
  const end = new Date(dateKey(finish) + 'T00:00:00.000Z');
  while (d <= end) {
    days.push(dateKey(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

function inRanges(key, ranges) {
  return ranges.some((r) => key >= dateKey(r.start) && key <= dateKey(r.end));
}

function betweenDays(key, start, end) {
  return key >= start && key <= end;
}

// True when an iteration path equals the base path or is nested beneath it.
// Compares on the separator so "Sprint 1" does not match "Sprint 10".
function isUnderPath(path, base) {
  if (!path || !base) return false;
  if (path === base) return true;
  return path.startsWith(base.endsWith('\\') ? base : `${base}\\`);
}

const esc = (s) => String(s).replace(/'/g, "''");

// Build a WIQL predicate that limits a query to a team's configured area paths.
// `field` is the prefix for the field, e.g. '[System.AreaPath]' or
// '[Source].[System.AreaPath]' for WorkItemLinks queries.
function areaPathClause(teamField, fieldExpr) {
  const values = teamField?.values || [];
  if (!values.length) return null;
  const parts = values.map((v) => {
    const op = v.includeChildren ? 'UNDER' : '=';
    return `${fieldExpr} ${op} '${esc(v.value)}'`;
  });
  return `(${parts.join(' OR ')})`;
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// Build a per-task chronological revision summary of the fields we track.
function summarizeRevisions(revisions) {
  const points = [];
  for (const rev of revisions) {
    const f = rev.fields || {};
    points.push({
      date: f[F.changedDate] || rev.rev,
      completed: num(f[F.completed]),
      remaining: num(f[F.remaining]),
      assignee: personName(f[F.assignedTo]),
      state: (f[F.state] || '').toLowerCase(),
      iterationPath: f[F.iterationPath] || '',
    });
  }
  points.sort((a, b) => new Date(a.date) - new Date(b.date));
  return points;
}

function valueAsOf(points, dayKey, field, fallback) {
  let val = fallback;
  for (const p of points) {
    if (dateKey(p.date) <= dayKey) val = p[field];
    else break;
  }
  return val;
}

function existsAsOf(points, dayKey) {
  return points.length > 0 && dateKey(points[0].date) <= dayKey;
}

// Sum story points for User Story/PBI/Requirement type items under a given
// iteration path, scoped to the team's area path(s). Returns planned
// (all non-removed stories) and completedToDate (Done/Closed/etc. stories).
async function fetchStoryPoints(client, iterationPath, taskArea) {
  if (!iterationPath) return { planned: 0, completedToDate: 0 };
  const typeClause = Array.from(STORY_TYPES).map((t) => `[System.WorkItemType] = '${esc(t)}'`).join(' OR ');
  const query =
    `SELECT [System.Id] FROM WorkItems WHERE (${typeClause}) ` +
    `AND [System.IterationPath] UNDER '${esc(iterationPath)}'` +
    (taskArea ? ` AND ${taskArea}` : '');
  const res = await client.wiql(query);
  const ids = (res.workItems || []).map((w) => w.id);
  if (!ids.length) return { planned: 0, completedToDate: 0 };
  const items = await client.getWorkItemsBatch(ids, [F.state, F.storyPoints]);
  let planned = 0;
  let completedToDate = 0;
  for (const it of items) {
    const f = it.fields || {};
    const state = (f[F.state] || '').toLowerCase();
    if (REMOVED_STATES.has(state)) continue;
    const pts = num(f[F.storyPoints]);
    planned += pts;
    if (COMPLETED_STATES.has(state)) completedToDate += pts;
  }
  return { planned: round(planned), completedToDate: round(completedToDate) };
}

// --- main dashboard ------------------------------------------------------

export async function buildDashboard(client, team, iterationId, options = {}) {
  const maxTasksForRevisions = Number.isFinite(options.maxTasksForRevisions)
    ? Math.max(1, Math.floor(options.maxTasksForRevisions))
    : Infinity;
  const maxOffSprintTasks = Number.isFinite(options.maxOffSprintTasks)
    ? Math.max(1, Math.floor(options.maxOffSprintTasks))
    : Infinity;
  const chunkOffset = Number.isFinite(options.taskOffset) ? Math.max(0, Math.floor(options.taskOffset)) : 0;
  const chunkLimit = Number.isFinite(options.taskLimit) ? Math.max(1, Math.floor(options.taskLimit)) : null;
  const chunkMode = Number.isFinite(chunkLimit);
  const enableOffSprintWatch = options.enableOffSprintWatch !== false;
  const staleImpedimentDays = Number.isFinite(options.staleImpedimentDays)
    ? Math.max(0, Math.floor(options.staleImpedimentDays))
    : DEFAULT_STALE_IMPEDIMENT_DAYS;

  const iterations = await client.getIterations(team);
  const iteration = iterations.find((it) => it.id === iterationId) || iterations[0];
  if (!iteration) throw new Error('No iterations found for this team.');
  if (!iteration.startDate || !iteration.finishDate) {
    throw new Error(`Iteration "${iteration.name}" has no start/finish dates set in ADO.`);
  }

  const [settings, capacities, teamDaysOff, teamField] = await Promise.all([
    client.getTeamSettings(team),
    client.getCapacities(team, iteration.id),
    client.getTeamDaysOff(team, iteration.id),
    client.getTeamFieldValues(team),
  ]);

  const workingDayNames = new Set((settings.workingDays || []).map((w) => w.toLowerCase()));
  if (workingDayNames.size === 0) ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].forEach((d) => workingDayNames.add(d));

  // People + capacity map keyed by display name.
  const people = new Map();
  for (const c of capacities) {
    const name = personName(c.teamMember);
    const perDay = (c.activities || []).reduce((s, a) => s + num(a.capacityPerDay), 0);
    people.set(name, { name, capacityPerDay: perDay, daysOff: c.daysOff || [] });
  }

  const capacityDiag = {
    membersReturned: capacities.length,
    withCapacity: Array.from(people.values()).filter((p) => p.capacityPerDay > 0).length,
    names: capacities.map((c) => personName(c.teamMember)),
    iterationName: iteration.name,
    teamName: team,
  };

  const allDays = enumerateDays(iteration.startDate, iteration.finishDate);
  const isWorking = (key) => {
    const weekday = WEEKDAYS[new Date(key + 'T00:00:00.000Z').getUTCDay()];
    return workingDayNames.has(weekday) && !inRanges(key, teamDaysOff);
  };
  const workingDays = allDays.filter(isWorking);

  // Tasks in the selected iteration, scoped to the team's area path(s).
  const taskArea = areaPathClause(teamField, '[System.AreaPath]');
  const taskQuery =
    `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'Task' ` +
    `AND [System.IterationPath] UNDER '${esc(iteration.path)}'` +
    (taskArea ? ` AND ${taskArea}` : '');

  // Previous sprint (by start date) relative to the selected iteration, used
  // to report last sprint's velocity in completed story points. Only computed
  // for the first chunk (or in non-chunked mode), same as capacityDiag/offSprintWork.
  const sortedIterations = [...iterations].sort((a, b) => new Date(a.startDate || 0) - new Date(b.startDate || 0));
  const currentIterationIdx = sortedIterations.findIndex((it) => it.id === iteration.id);
  const previousIteration = currentIterationIdx > 0 ? sortedIterations[currentIterationIdx - 1] : null;
  const shouldComputeStoryPoints = !chunkMode || chunkOffset === 0;

  const [taskRes, currentStoryPoints, previousStoryPoints] = await Promise.all([
    client.wiql(taskQuery),
    shouldComputeStoryPoints ? fetchStoryPoints(client, iteration.path, taskArea) : Promise.resolve({ planned: 0, completedToDate: 0 }),
    shouldComputeStoryPoints && previousIteration ? fetchStoryPoints(client, previousIteration.path, taskArea) : Promise.resolve(null),
  ]);
  const taskIds = (taskRes.workItems || []).map((w) => w.id);
  const today = dateKey(new Date());
  const asOfDay = [...workingDays].reverse().find((d) => d <= today) || null;
  const sprintStart = workingDays[0] || dateKey(iteration.startDate);
  const sprintEnd = workingDays[workingDays.length - 1] || dateKey(iteration.finishDate);
  const selectedTaskIds = chunkMode ? taskIds.slice(chunkOffset, chunkOffset + chunkLimit) : taskIds;
  const taskItems = selectedTaskIds.length
    ? await client.getWorkItemsBatch(selectedTaskIds, [F.title, F.assignedTo, F.remaining, F.changedDate])
    : [];
  const taskTitleById = new Map(taskItems.map((w) => [w.id, w.fields?.[F.title] || `Task ${w.id}`]));
  const taskIdSet = new Set(selectedTaskIds);
  let taskboardItems = [];
  try {
    taskboardItems = await client.getTaskboardWorkItems(team, iteration.id);
  } catch (e) {
    console.warn(`[impeded] taskboard read failed: ${e.message}`);
  }
  const impededTaskIds = new Set(
    taskboardItems
      .filter((item) => isImpededColumn(taskboardColumn(item)))
      .map((item) => taskboardId(item))
      .filter((id) => id && taskIdSet.has(id)),
  );
  // Impeded tasks, plus the ones that have gone stale. A task counts as stale
  // when nobody has touched the work item for MORE than `staleImpedimentDays`
  // business days (weekends and team days off don't count) -- an impediment
  // nobody is updating is the one most likely to be forgotten.
  const impededHoursByPerson = {};
  const impededCountByPerson = {};
  const staleImpededByPerson = {};
  const staleImpededTasksByPerson = {};
  const nowMs = Date.now();
  for (const t of taskItems) {
    if (!impededTaskIds.has(t.id)) continue;
    const f = t.fields || {};
    const assignee = personName(f[F.assignedTo]);
    const remaining = num(f[F.remaining]);
    impededHoursByPerson[assignee] = round(num(impededHoursByPerson[assignee]) + remaining);
    impededCountByPerson[assignee] = (impededCountByPerson[assignee] || 0) + 1;

    const changedRaw = f[F.changedDate];
    const changedMs = changedRaw ? new Date(changedRaw).getTime() : NaN;
    if (!Number.isFinite(changedMs)) continue;
    const businessDays = businessDaysBetween(changedMs, nowMs, isWorking);
    if (!(businessDays > staleImpedimentDays)) continue;
    const daysSinceUpdate = round(businessDays);
    staleImpededByPerson[assignee] = (staleImpededByPerson[assignee] || 0) + 1;
    (staleImpededTasksByPerson[assignee] ||= []).push({
      id: t.id,
      title: f[F.title] || `Task ${t.id}`,
      remaining: round(remaining),
      daysSinceUpdate,
      changedDate: changedRaw,
    });
  }
  for (const list of Object.values(staleImpededTasksByPerson)) {
    list.sort((a, b) => (b.daysSinceUpdate - a.daysSinceUpdate) || (b.remaining - a.remaining));
  }

  const revisionTaskIds = selectedTaskIds.slice(0, Math.min(selectedTaskIds.length, maxTasksForRevisions));
  const revisionsByTask = await pool(
    revisionTaskIds,
    6,
    async (id) => ({ id, points: summarizeRevisions(await client.getRevisions(id)) }),
  );
  const revisionsTruncated = revisionTaskIds.length < taskIds.length;

  const offSprintDayTaskActivity = {};
  const offSprintPointsById = new Map();
  let offSprintItems = [];
  const offSprintByPerson = {};

  // Hours that left the sprint, keyed by day. Filled from two sources:
  // tasks set to a Removed/Cut state, and tasks moved to another iteration.
  const dailyScopeRemoved = {};

  // Skip off-sprint watch on day 1 of sprint planning updates.
  const watchDayActive = asOfDay && workingDays.filter((d) => d <= asOfDay).length > 1;
  const shouldComputeOffSprint = enableOffSprintWatch && watchDayActive && (!chunkMode || chunkOffset === 0);
  if (shouldComputeOffSprint) {
    // Tasks worked during this sprint window but currently assigned to a
    // different iteration path (outside the selected sprint).
    const outSprintQuery =
      `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'Task' ` +
      `AND [System.ChangedDate] >= '${sprintStart}' ` +
      `AND [System.ChangedDate] <= '${sprintEnd}' ` +
      `AND NOT [System.IterationPath] UNDER '${esc(iteration.path)}'` +
      (taskArea ? ` AND ${taskArea}` : '') +
      ` ORDER BY [System.ChangedDate] DESC`;
    const outSprintRes = await client.wiql(outSprintQuery);
    const outSprintIds = Array.from(
      new Set((outSprintRes.workItems || []).map((w) => w.id).filter((id) => !taskIdSet.has(id))),
    );
    const selectedOutSprintIds = outSprintIds.slice(0, Math.min(outSprintIds.length, maxOffSprintTasks));
    const outSprintItemsRaw = selectedOutSprintIds.length
      ? await client.getWorkItemsBatch(selectedOutSprintIds, [F.title, F.iterationPath])
      : [];
    const outSprintById = new Map(outSprintItemsRaw.map((w) => [w.id, w.fields || {}]));
    const outSprintRevisions = await pool(
      selectedOutSprintIds,
      4,
      async (id) => ({ id, points: summarizeRevisions(await client.getRevisions(id)) }),
    );

    for (const t of outSprintRevisions) {
      offSprintPointsById.set(t.id, t.points);
      const f = outSprintById.get(t.id) || {};
      const perPerson = {};
      let totalWorked = 0;
      let totalBurned = 0;
      let prevCompleted = 0;
      let prevRemaining = null;
      let prevIterationPath = null;

      for (const p of t.points) {
        const key = dateKey(p.date);
        const inSprintWindow = betweenDays(key, sprintStart, sprintEnd);
        const wDelta = p.completed - prevCompleted;
        prevCompleted = p.completed;
        if (inSprintWindow && wDelta > 0 && !isUnassignedPerson(p.assignee)) {
          if (!perPerson[p.assignee]) perPerson[p.assignee] = { worked: 0, burned: 0 };
          perPerson[p.assignee].worked += wDelta;
          totalWorked += wDelta;
          if (!offSprintDayTaskActivity[p.assignee]) offSprintDayTaskActivity[p.assignee] = {};
          if (!offSprintDayTaskActivity[p.assignee][key]) offSprintDayTaskActivity[p.assignee][key] = {};
          const slot = offSprintDayTaskActivity[p.assignee][key];
          if (!slot[t.id]) {
            slot[t.id] = {
              id: t.id,
              title: f[F.title] || `Task ${t.id}`,
              iterationPath: f[F.iterationPath] || '',
              worked: 0,
              burned: 0,
            };
          }
          slot[t.id].worked += wDelta;
        }

        if (prevRemaining !== null) {
          const burn = prevRemaining - p.remaining;
          if (inSprintWindow && burn > 0 && !isUnassignedPerson(p.assignee)) {
            if (!perPerson[p.assignee]) perPerson[p.assignee] = { worked: 0, burned: 0 };
            perPerson[p.assignee].burned += burn;
            totalBurned += burn;
            if (!offSprintDayTaskActivity[p.assignee]) offSprintDayTaskActivity[p.assignee] = {};
            if (!offSprintDayTaskActivity[p.assignee][key]) offSprintDayTaskActivity[p.assignee][key] = {};
            const slot = offSprintDayTaskActivity[p.assignee][key];
            if (!slot[t.id]) {
              slot[t.id] = {
                id: t.id,
                title: f[F.title] || `Task ${t.id}`,
                iterationPath: f[F.iterationPath] || '',
                worked: 0,
                burned: 0,
              };
            }
            slot[t.id].burned += burn;
          }
        }

        // Scope removed: the task was moved out of the sprint iteration
        // mid-sprint. The Remaining Work it carried at that moment is the
        // scope that left.
        if (
          inSprintWindow
          && prevIterationPath !== null
          && isUnderPath(prevIterationPath, iteration.path)
          && !isUnderPath(p.iterationPath, iteration.path)
        ) {
          const lost = num(prevRemaining);
          if (lost > 0) {
            (dailyScopeRemoved[key] ||= 0);
            dailyScopeRemoved[key] += lost;
          }
        }

        prevIterationPath = p.iterationPath;
        prevRemaining = p.remaining;
      }

      // "Outside-sprint tasks worked" must only include tasks with
      // positive worked deltas during the sprint window.
      if (totalWorked <= 0) continue;

      const people = Object.entries(perPerson)
        .map(([name, v]) => ({ name, worked: round(v.worked), burned: round(v.burned) }))
        .sort((a, b) => (b.worked + b.burned) - (a.worked + a.burned));

      for (const p of people) {
        if (!offSprintByPerson[p.name]) offSprintByPerson[p.name] = { worked: 0, burned: 0, tasks: 0 };
        offSprintByPerson[p.name].worked += p.worked;
        offSprintByPerson[p.name].burned += p.burned;
        offSprintByPerson[p.name].tasks += 1;
      }

      offSprintItems.push({
        id: t.id,
        title: f[F.title] || `Task ${t.id}`,
        iterationPath: f[F.iterationPath] || '',
        worked: round(totalWorked),
        burned: round(totalBurned),
        people,
      });
    }
  }

  offSprintItems.sort((a, b) => (b.worked + b.burned) - (a.worked + a.burned));
  const offSprintPeople = Object.entries(offSprintByPerson)
    .map(([name, v]) => ({ name, worked: round(v.worked), burned: round(v.burned), tasks: v.tasks }))
    .sort((a, b) => (b.worked + b.burned) - (a.worked + a.burned));
  const offSprintPeopleWithWorked = new Set(
    offSprintPeople.filter((p) => p.worked > 0).map((p) => p.name),
  );
  const offSprintTotals = {
    worked: round(offSprintItems.reduce((s, it) => s + it.worked, 0)),
    burned: round(offSprintItems.reduce((s, it) => s + it.burned, 0)),
    taskCount: offSprintItems.length,
  };

  for (const name of offSprintPeopleWithWorked) {
    if (!people.has(name)) people.set(name, { name, capacityPerDay: 0, daysOff: [] });
  }

  // Someone whose only footprint this sprint is a blocked task still needs a
  // row, otherwise their impediment would be invisible.
  for (const name of Object.keys(impededCountByPerson)) {
    if (!people.has(name)) people.set(name, { name, capacityPerDay: 0, daysOff: [] });
  }

  // Ensure every assignee that logged work appears as a person row.
  for (const t of revisionsByTask) {
    for (const p of t.points) {
      if (!people.has(p.assignee)) people.set(p.assignee, { name: p.assignee, capacityPerDay: 0, daysOff: [] });
    }
  }

  // Remaining Work a task carried at the close of `day` (its last revision on
  // or before that day), so the day-detail tooltip can show R next to W and B.
  const pointsByTaskId = new Map(revisionsByTask.map((t) => [t.id, t.points]));
  function remainingAtEndOf(points, day) {
    let last = null;
    for (const p of points || []) {
      if (dateKey(p.date) > day) break;
      last = p;
    }
    return last ? round(last.remaining) : null;
  }
  // --- Daily hours per person (completed-work deltas attributed to assignee) ---
  // dailyWorked[dayKey][person] = hours logged that day.
  // dailyBurned[dayKey][person] = remaining-work reduction that day (burndown).
  const dailyWorked = {};
  const dailyBurned = {};
  const dailyScopeAdded = {};
  const personTaskTouches = {};
  const personDayTaskActivity = {};

  function addTaskActivity(person, day, taskId, worked, burned) {
    if (!personDayTaskActivity[person]) personDayTaskActivity[person] = {};
    if (!personDayTaskActivity[person][day]) personDayTaskActivity[person][day] = {};
    if (!personDayTaskActivity[person][day][taskId]) {
      personDayTaskActivity[person][day][taskId] = {
        id: taskId,
        title: taskTitleById.get(taskId) || `Task ${taskId}`,
        worked: 0,
        burned: 0,
      };
    }
    personDayTaskActivity[person][day][taskId].worked = round(
      personDayTaskActivity[person][day][taskId].worked + num(worked),
    );
    personDayTaskActivity[person][day][taskId].burned = round(
      personDayTaskActivity[person][day][taskId].burned + num(burned),
    );
  }

  for (const t of revisionsByTask) {
    let prevCompleted = 0;
    let prevRemaining = null;
    let prevState = null;
    for (const p of t.points) {
      if (asOfDay && dateKey(p.date) <= asOfDay) {
        if (!personTaskTouches[p.assignee]) personTaskTouches[p.assignee] = new Set();
        personTaskTouches[p.assignee].add(t.id);
      }

      const wDelta = p.completed - prevCompleted;
      prevCompleted = p.completed;
      if (wDelta !== 0) {
        const key = dateKey(p.date);
        (dailyWorked[key] ||= {});
        dailyWorked[key][p.assignee] = num(dailyWorked[key][p.assignee]) + wDelta;
        if (wDelta > 0) addTaskActivity(p.assignee, key, t.id, wDelta, 0);
      }

      // Burned = decrease in Remaining Work (increases don't count as burn).
      if (prevRemaining !== null) {
        const burn = prevRemaining - p.remaining;
        if (burn > 0) {
          const key = dateKey(p.date);
          (dailyBurned[key] ||= {});
          dailyBurned[key][p.assignee] = num(dailyBurned[key][p.assignee]) + burn;
          addTaskActivity(p.assignee, key, t.id, 0, burn);
        }
        const add = p.remaining - prevRemaining;
        if (add > 0) {
          const key = dateKey(p.date);
          (dailyScopeAdded[key] ||= 0);
          dailyScopeAdded[key] += add;
        }
      }

      // Scope removed: the task was cut from the sprint by moving to a
      // Removed/Cut state. Credit the Remaining Work it still carried.
      if (prevState !== null && !REMOVED_STATES.has(prevState) && REMOVED_STATES.has(p.state)) {
        const lost = num(prevRemaining);
        if (lost > 0) {
          const key = dateKey(p.date);
          (dailyScopeRemoved[key] ||= 0);
          dailyScopeRemoved[key] += lost;
        }
      }

      prevState = p.state;
      prevRemaining = p.remaining;
    }
  }

  const personList = Array.from(people.values()).sort((a, b) => a.name.localeCompare(b.name));

  const dailyHours = {
    days: workingDays,
    people: personList.map((person) => {
      const cells = workingDays.map((day) => {
        const worked = num(dailyWorked[day]?.[person.name]);
        const burned = num(dailyBurned[day]?.[person.name]);
        const off = inRanges(day, person.daysOff) || inRanges(day, teamDaysOff);
        const capacity = off ? 0 : person.capacityPerDay;
        return { day, worked: round(worked), burned: round(burned), capacity: round(capacity), off };
      });
      return {
        name: person.name,
        capacityPerDay: person.capacityPerDay,
        cells,
        totalWorked: round(cells.reduce((s, c) => s + c.worked, 0)),
        totalBurned: round(cells.reduce((s, c) => s + c.burned, 0)),
        totalCapacity: round(cells.reduce((s, c) => s + c.capacity, 0)),
      };
    }),
  };

  // --- Burndown series (per working day) ---
  const teamBurndown = [];
  const personRemaining = {}; // person -> [{day, hours}]
  const personCompleted = {}; // person -> cumulative
  const names = personList.map((p) => p.name);
  names.forEach((n) => {
    personRemaining[n] = [];
    personCompleted[n] = [];
  });

  // Cumulative completed per person up to and including each day.
  const cumCompleted = Object.fromEntries(names.map((n) => [n, 0]));
  const asOfPersonRemaining = Object.fromEntries(names.map((n) => [n, 0]));
  const asOfPersonCompleted = Object.fromEntries(names.map((n) => [n, 0]));
  let asOfTeamRemaining = 0;

  for (const day of workingDays) {
    const isFuture = day > today;
    let teamRemaining = 0;
    let unassignedRemaining = 0;
    const perPersonRemaining = Object.fromEntries(names.map((n) => [n, 0]));

    for (const t of revisionsByTask) {
      if (!existsAsOf(t.points, day)) continue;
      const remaining = num(valueAsOf(t.points, day, 'remaining', 0));
      const assignee = valueAsOf(t.points, day, 'assignee', 'Unassigned');
      teamRemaining += remaining;
      if (assignee === 'Unassigned') unassignedRemaining += remaining;
      if (perPersonRemaining[assignee] === undefined) perPersonRemaining[assignee] = 0;
      perPersonRemaining[assignee] += remaining;
    }

    // add the day's completed deltas to cumulative
    const worked = dailyWorked[day] || {};
    for (const [name, hrs] of Object.entries(worked)) {
      if (cumCompleted[name] === undefined) cumCompleted[name] = 0;
      cumCompleted[name] += hrs;
    }

    // Actual lines stop after today: future days are null so the line ends,
    // while the ideal line and x-axis still span the full sprint.
    teamBurndown.push({
      day,
      remaining: isFuture ? null : round(teamRemaining),
      unassigned: isFuture ? null : round(unassignedRemaining),
    });
    for (const n of names) {
      personRemaining[n].push({ day, hours: isFuture ? null : round(perPersonRemaining[n] || 0) });
      personCompleted[n].push({ day, hours: isFuture ? null : round(cumCompleted[n] || 0) });
    }

    if (asOfDay && day === asOfDay) {
      asOfTeamRemaining = round(teamRemaining);
      for (const n of names) {
        asOfPersonRemaining[n] = round(perPersonRemaining[n] || 0);
        asOfPersonCompleted[n] = round(cumCompleted[n] || 0);
      }
    }
  }

  // Ideal line for the team burndown.
  const startRemaining = teamBurndown.length ? teamBurndown[0].remaining : 0;
  const ideal = teamBurndown.map((pt, i) => ({
    day: pt.day,
    ideal: round(startRemaining * (1 - i / Math.max(1, teamBurndown.length - 1))),
  }));

  const elapsedWorkingDays = workingDays.filter((d) => d <= today).length;
  const remainingWorkingDays = workingDays.filter((d) => d > today).length;
  const dailyPeople = dailyHours.people;

  const personMetrics = dailyPeople
    .map((p) => {
      const cellsToDate = p.cells.filter((c) => c.day <= today);
      const workedToDate = round(cellsToDate.reduce((s, c) => s + c.worked, 0));
      const burnedToDate = round(cellsToDate.reduce((s, c) => s + c.burned, 0));
      const capacityToDate = round(cellsToDate.reduce((s, c) => s + c.capacity, 0));
      const workedDays = cellsToDate.filter((c) => c.worked > 0).length;
      const burnedDays = cellsToDate.filter((c) => c.burned > 0).length;
      const utilizationPct = pct(workedToDate, capacityToDate);
      const burnEfficiencyPct = pct(burnedToDate, workedToDate);
      const remainingToday = asOfDay ? round(asOfPersonRemaining[p.name] || 0) : 0;
      const completedToDate = asOfDay ? round(asOfPersonCompleted[p.name] || 0) : 0;
      const impededToday = round(impededHoursByPerson[p.name] || 0);
      const impededTaskCount = impededCountByPerson[p.name] || 0;
      const staleImpededCount = staleImpededByPerson[p.name] || 0;
      const staleImpededTasks = staleImpededTasksByPerson[p.name] || [];
      const tasksTouched = (personTaskTouches[p.name] && personTaskTouches[p.name].size) || 0;
      const avgWorkedPerDay = elapsedWorkingDays > 0 ? round(workedToDate / elapsedWorkingDays) : 0;
      const avgBurnedPerDay = elapsedWorkingDays > 0 ? round(burnedToDate / elapsedWorkingDays) : 0;
      const overUnderToDate = round(workedToDate - capacityToDate);

      return {
        name: p.name,
        capacityPerDay: round(p.capacityPerDay),
        workedToDate,
        burnedToDate,
        completedToDate,
        impededToday,
        impededTaskCount,
        staleImpededCount,
        staleImpededTasks,
        remainingToday,
        capacityToDate,
        utilizationPct,
        burnEfficiencyPct,
        workedDays,
        burnedDays,
        avgWorkedPerDay,
        avgBurnedPerDay,
        overUnderToDate,
        tasksTouched,
      };
    })
    .filter(
      (p) => p.capacityPerDay > 0
        || p.workedToDate > 0
        || p.burnedToDate > 0
        || p.remainingToday > 0
        || p.impededTaskCount > 0
        || offSprintPeopleWithWorked.has(p.name),
    )
    .sort((a, b) => {
      if (b.burnedToDate !== a.burnedToDate) return b.burnedToDate - a.burnedToDate;
      return a.name.localeCompare(b.name);
    });

  const teamWorkedToDate = round(personMetrics.reduce((s, p) => s + p.workedToDate, 0));
  const teamBurnedToDate = round(personMetrics.reduce((s, p) => s + p.burnedToDate, 0));
  const teamCapacityToDate = round(personMetrics.reduce((s, p) => s + p.capacityToDate, 0));
  const contributorsActive = personMetrics.filter((p) => p.workedToDate > 0 || p.burnedToDate > 0).length;
  const tasksTouchedCount = Object.values(personTaskTouches).reduce((s, set) => s + set.size, 0);
  const scopeAddedToDate = round(
    Object.entries(dailyScopeAdded)
      .filter(([day]) => day >= sprintStart && day <= today)
      .reduce((s, [, hrs]) => s + num(hrs), 0),
  );
  const scopeRemovedToDate = round(
    Object.entries(dailyScopeRemoved)
      .filter(([day]) => day >= sprintStart && day <= today)
      .reduce((s, [, hrs]) => s + num(hrs), 0),
  );

  const teamMetrics = {
    elapsedWorkingDays,
    totalWorkingDays: workingDays.length,
    remainingWorkingDays,
    contributorsActive,
    taskCount: taskIds.length,
    tasksTouchedCount,
    workedToDate: teamWorkedToDate,
    burnedToDate: teamBurnedToDate,
    remainingToday: asOfDay ? asOfTeamRemaining : null,
    capacityToDate: teamCapacityToDate,
    utilizationPct: pct(teamWorkedToDate, teamCapacityToDate),
    burnEfficiencyPct: pct(teamBurnedToDate, teamWorkedToDate),
    scopeAddedToDate,
    scopeRemovedToDate,
    staleImpedimentDays,
    staleImpededCount: personMetrics.reduce((s, p) => s + p.staleImpededCount, 0),
    impededTaskCount: personMetrics.reduce((s, p) => s + p.impededTaskCount, 0),
    generatedThrough: asOfDay,
  };

  return {
    iteration,
    workingDays,
    dailyHours,
    capacityDiag,
    teamMetrics,
    storyPoints: {
      planned: currentStoryPoints.planned,
      completedToDate: currentStoryPoints.completedToDate,
      velocityPreviousSprint: previousIteration ? (previousStoryPoints?.completedToDate ?? null) : null,
      previousSprintName: previousIteration?.name || null,
    },
    offSprintWork: {
      totals: offSprintTotals,
      byPerson: offSprintPeople,
      items: offSprintItems,
      sprintStart,
      sprintEnd,
      skippedOnDayOne: !!(asOfDay && workingDays.filter((d) => d <= asOfDay).length <= 1),
      disabledByLimit: !enableOffSprintWatch || (chunkMode && chunkOffset > 0),
    },
    offSprintDayTaskActivity: Object.fromEntries(
      Object.entries(offSprintDayTaskActivity).map(([person, days]) => ([
        person,
        Object.fromEntries(
          Object.entries(days).map(([day, items]) => ([
            day,
            Object.values(items)
              .map((it) => ({
                ...it,
                worked: round(it.worked),
                burned: round(it.burned),
                remaining: remainingAtEndOf(offSprintPointsById.get(it.id), day),
              }))
              .sort((a, b) => (b.worked + b.burned) - (a.worked + a.burned)),
          ])),
        ),
      ])),
    ),
    personMetrics,
    personDayTaskActivity: Object.fromEntries(
      Object.entries(personDayTaskActivity).map(([person, days]) => ([
        person,
        Object.fromEntries(
          Object.entries(days).map(([day, items]) => ([
            day,
            Object.values(items)
              .filter((it) => it.worked > 0 || it.burned > 0)
              .map((it) => ({ ...it, remaining: remainingAtEndOf(pointsByTaskId.get(it.id), day) }))
              .sort((a, b) => (b.worked + b.burned) - (a.worked + a.burned)),
          ])),
        ),
      ])),
    ),
    burndown: {
      team: teamBurndown.map((pt, i) => ({ ...pt, ideal: ideal[i].ideal })),
      people: names.map((n) => ({
        name: n,
        capacityPerDay: people.get(n)?.capacityPerDay || 0,
        remaining: personRemaining[n],
        completed: personCompleted[n],
      })),
    },
    taskCount: taskIds.length,
    revisionsTaskCount: revisionTaskIds.length,
    chunk: chunkMode ? {
      offset: chunkOffset,
      limit: chunkLimit,
      count: revisionTaskIds.length,
      hasMore: chunkOffset + revisionTaskIds.length < taskIds.length,
      nextOffset: chunkOffset + revisionTaskIds.length,
    } : null,
    warnings: [
      ...(revisionsTruncated
        ? [`Cloud limit mode: revision history capped at ${revisionTaskIds.length} of ${selectedTaskIds.length} selected tasks.`]
        : []),
      ...(chunkMode
        ? [`Cloud chunk mode: loaded tasks ${chunkOffset + 1}-${Math.min(taskIds.length, chunkOffset + revisionTaskIds.length)} of ${taskIds.length}.`]
        : []),
      ...(!enableOffSprintWatch ? ['Cloud limit mode: outside-sprint watcher disabled.'] : []),
      ...(chunkMode && chunkOffset > 0 ? ['Cloud chunk mode: outside-sprint watcher computed in first batch only.'] : []),
      ...(shouldComputeOffSprint && Number.isFinite(maxOffSprintTasks) && offSprintItems.length >= maxOffSprintTasks
        ? [`Cloud limit mode: outside-sprint watcher capped at ${maxOffSprintTasks} tasks.`]
        : []),
    ],
    generatedAt: new Date().toISOString(),
  };
}

// --- feature status ------------------------------------------------------

export async function buildFeatures(client, team, iterationId) {
  const [iterations, teamField] = await Promise.all([client.getIterations(team), client.getTeamFieldValues(team)]);
  const iteration = iterations.find((it) => it.id === iterationId) || null;
  const iterationPath = iteration?.path || null;

  // Recursive hierarchy from Features downward, scoped to the team's area
  // path(s) so we never scan the whole (20k+ item) project.
  const sourceArea = areaPathClause(teamField, '[Source].[System.AreaPath]');
  const linkQuery =
    `SELECT [System.Id] FROM WorkItemLinks WHERE ([Source].[System.WorkItemType] = 'Feature') ` +
    (sourceArea ? `AND (${sourceArea}) ` : '') +
    `AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward') MODE (Recursive)`;
  const linkRes = await client.wiql(linkQuery);
  const rels = linkRes.workItemRelations || [];

  const childrenOf = new Map();
  const ids = new Set();
  const featureIds = new Set();
  for (const rel of rels) {
    if (rel.target) ids.add(rel.target.id);
    if (rel.source) ids.add(rel.source.id);
    if (!rel.source && rel.target) featureIds.add(rel.target.id); // root = Feature
    if (rel.source && rel.target) {
      if (!childrenOf.has(rel.source.id)) childrenOf.set(rel.source.id, []);
      childrenOf.get(rel.source.id).push(rel.target.id);
    }
  }

  const items = await client.getWorkItemsBatch(Array.from(ids), [
    F.type, F.state, F.title, F.storyPoints, F.completed, F.remaining, F.targetDate, F.iterationPath,
    F.stackRank, F.backlogPriority, F.priority,
  ]);
  const byId = new Map(items.map((w) => [w.id, w.fields || {}]));

  // Any Feature returned by the query (including ones with no children).
  for (const w of items) {
    if ((w.fields?.[F.type] || '').toLowerCase() === 'feature') featureIds.add(w.id);
  }

  function descend(id, acc) {
    for (const child of childrenOf.get(id) || []) {
      acc.push(child);
      descend(child, acc);
    }
    return acc;
  }

  const features = [];
  for (const fid of featureIds) {
    const f = byId.get(fid);
    if (!f) continue;
    if (REMOVED_STATES.has((f[F.state] || '').toLowerCase())) continue;

    const descendants = descend(fid, []).map((id) => byId.get(id)).filter(Boolean);

    let pointsTotal = 0;
    let pointsDone = 0;
    let hoursRemaining = 0;
    let hoursComplete = 0;
    let inIteration = false;

    for (const d of descendants) {
      const type = (d[F.type] || '').toLowerCase();
      const state = (d[F.state] || '').toLowerCase();
      if (iterationPath && (d[F.iterationPath] || '').startsWith(iterationPath)) inIteration = true;

      if (type === 'task') {
        hoursRemaining += num(d[F.remaining]);
        hoursComplete += num(d[F.completed]);
      }
      const isStory = STORY_TYPES.has(type) || (d[F.storyPoints] != null && type !== 'feature' && type !== 'epic' && type !== 'task');
      if (isStory) {
        const pts = num(d[F.storyPoints]);
        pointsTotal += pts;
        if (COMPLETED_STATES.has(state)) pointsDone += pts;
      }
    }

    const rank = f[F.stackRank] != null ? num(f[F.stackRank])
      : f[F.backlogPriority] != null ? num(f[F.backlogPriority])
      : null;

    features.push({
      id: fid,
      title: f[F.title] || `Feature ${fid}`,
      state: f[F.state] || '',
      targetDate: f[F.targetDate] || null,
      storyPointsTotal: round(pointsTotal),
      storyPointsDone: round(pointsDone),
      percentComplete: pointsTotal > 0 ? Math.round((pointsDone / pointsTotal) * 100) : 0,
      hoursRemaining: round(hoursRemaining),
      hoursComplete: round(hoursComplete),
      rank,
      priority: f[F.priority] != null ? num(f[F.priority]) : null,
      inIteration,
    });
  }

  // Backlog priority order: lower Stack Rank = higher priority. Items without a
  // rank fall to the bottom, tie-broken by title.
  features.sort((a, b) => {
    const ar = a.rank == null ? Infinity : a.rank;
    const br = b.rank == null ? Infinity : b.rank;
    if (ar !== br) return ar - br;
    return a.title.localeCompare(b.title);
  });
  features.forEach((f, i) => { f.priorityOrder = i + 1; });

  return {
    iterationPath,
    iterationFeatures: features.filter((f) => f.inIteration),
    backlogFeatures: features,
  };
}

// --- feature + children CSV export ---------------------------------------

const EXPORT_STATES = new Set(['new', 'active']);

// Columns that lead the export; every other field the work items carry follows
// alphabetically.
const EXPORT_LEAD_FIELDS = [
  'System.Id', 'System.WorkItemType', 'System.Title', 'System.State', 'System.Reason',
  'System.AssignedTo', 'System.AreaPath', 'System.IterationPath',
];
const EXPORT_SYNTHETIC = ['Feature ID', 'Feature Title', 'Parent ID', 'Hierarchy Level', 'Work Item URL', 'Rev'];

// Area paths are case-insensitive in ADO.
function inTeamAreas(areaPath, values) {
  const p = String(areaPath || '').toLowerCase();
  if (!p) return false;
  return values.some((v) => {
    const base = String(v.value || '').toLowerCase();
    if (!base) return false;
    return p === base || (v.includeChildren && p.startsWith(`${base}\\`));
  });
}

// Identity fields arrive as objects; everything else is a scalar or, rarely,
// a structured value that is kept as JSON rather than "[object Object]".
function flattenFieldValue(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.displayName) return v.uniqueName ? `${v.displayName} <${v.uniqueName}>` : v.displayName;
    return JSON.stringify(v);
  }
  return v;
}

/**
 * Every New/Active Feature owned by `team`, followed by its New/Active
 * descendants, with every field ADO returns for them. Items are kept only when
 * they sit in the team's own area path(s), so work another team owns beneath a
 * shared Feature is not exported under this team.
 */
export async function buildFeatureExport(client, team) {
  const teamField = await client.getTeamFieldValues(team);
  const areas = teamField.values || [];
  if (!areas.length) {
    // Without an area filter the query would span the whole project.
    const err = new Error(`Team "${team}" has no area paths configured, so its work items cannot be scoped. Nothing was exported.`);
    err.status = 422;
    throw err;
  }

  const states = "'New', 'Active'";
  const sourceArea = areaPathClause(teamField, '[Source].[System.AreaPath]');
  const linkQuery =
    `SELECT [System.Id] FROM WorkItemLinks WHERE ([Source].[System.WorkItemType] = 'Feature' ` +
    `AND [Source].[System.State] IN (${states})) AND ${sourceArea} ` +
    `AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward') MODE (Recursive)`;
  const linkRes = await client.wiql(linkQuery);

  const childrenOf = new Map();
  const parentOf = new Map();
  const ids = new Set();
  for (const rel of linkRes.workItemRelations || []) {
    if (rel.target) ids.add(rel.target.id);
    if (rel.source) ids.add(rel.source.id);
    if (rel.source && rel.target) {
      if (!childrenOf.has(rel.source.id)) childrenOf.set(rel.source.id, []);
      childrenOf.get(rel.source.id).push(rel.target.id);
      parentOf.set(rel.target.id, rel.source.id);
    }
  }

  // No field list: ask ADO for every field each item carries.
  const items = await client.getWorkItemsBatch(Array.from(ids));
  const byId = new Map(items.map((w) => [w.id, w]));
  const fieldsOf = (id) => byId.get(id)?.fields || {};
  const isFeature = (id) => String(fieldsOf(id)[F.type] || '').toLowerCase() === 'feature';
  const keep = (id) => {
    const f = fieldsOf(id);
    return EXPORT_STATES.has(String(f[F.state] || '').toLowerCase()) && inTeamAreas(f[F.areaPath], areas);
  };
  const rankOf = (id) => {
    const f = fieldsOf(id);
    const r = f[F.stackRank] != null ? f[F.stackRank] : f[F.backlogPriority];
    return r == null ? Infinity : num(r);
  };
  const byRank = (a, b) => (rankOf(a) - rankOf(b)) || (a - b);

  // A Feature nested under another kept Feature is exported beneath its parent.
  const hasKeptFeatureAncestor = (id) => {
    const seen = new Set();
    for (let p = parentOf.get(id); p != null && !seen.has(p); p = parentOf.get(p)) {
      seen.add(p);
      if (isFeature(p) && keep(p)) return true;
    }
    return false;
  };
  const roots = Array.from(ids)
    .filter((id) => isFeature(id) && keep(id) && !hasKeptFeatureAncestor(id))
    .sort((a, b) => (rankOf(a) - rankOf(b)) || String(fieldsOf(a)[F.title] || '').localeCompare(String(fieldsOf(b)[F.title] || '')));

  const orgUrl = `https://dev.azure.com/${client.org}/${encodeURIComponent(client.project)}`;
  const records = [];
  const seen = new Set();
  function walk(id, level, parentId, rootId) {
    if (seen.has(id)) return;
    seen.add(id);
    if (keep(id)) {
      const w = byId.get(id);
      const values = {
        'Feature ID': rootId,
        'Feature Title': fieldsOf(rootId)[F.title] || '',
        'Parent ID': parentId ?? '',
        'Hierarchy Level': level,
        'Work Item URL': `${orgUrl}/_workitems/edit/${id}`,
        Rev: w.rev ?? '',
      };
      for (const [k, v] of Object.entries(w.fields || {})) values[k] = flattenFieldValue(v);
      records.push(values);
    }
    // Descend through items that were filtered out too: a New task can sit
    // under a Closed story.
    for (const child of (childrenOf.get(id) || []).slice().sort(byRank)) walk(child, level + 1, id, rootId);
  }
  for (const root of roots) walk(root, 0, null, root);

  const fieldNames = new Set();
  for (const r of records) for (const k of Object.keys(r)) if (!EXPORT_SYNTHETIC.includes(k)) fieldNames.add(k);
  const leadPresent = EXPORT_LEAD_FIELDS.filter((k) => fieldNames.has(k));
  const rest = Array.from(fieldNames).filter((k) => !leadPresent.includes(k)).sort((a, b) => a.localeCompare(b));
  const columns = [...EXPORT_SYNTHETIC, ...leadPresent, ...rest];

  return {
    team,
    states: ['New', 'Active'],
    columns,
    rows: records.map((r) => columns.map((c) => (r[c] === undefined ? '' : r[c]))),
    featureCount: roots.length,
    count: records.length,
    generatedAt: new Date().toISOString(),
  };
}

function round(n) {
  return Math.round(num(n) * 100) / 100;
}

function pct(part, whole) {
  if (!whole || whole <= 0) return null;
  return Math.round((num(part) / num(whole)) * 100);
}

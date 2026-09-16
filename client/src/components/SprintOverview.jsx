import React, { useMemo, useRef } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ComposedChart,
  Bar,
} from 'recharts';
import { exportCsv, exportPng } from '../utils/exports.js';

function shortDay(key) {
  return new Date(key + 'T00:00:00.000Z').toLocaleDateString('en-US', {
    month: 'numeric',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function pct(v) {
  return v == null ? '—' : `${v}%`;
}

function fmt(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function isUnassigned(name) {
  return String(name || '').trim().toLowerCase() === 'unassigned';
}

export default function SprintOverview({ dashboard }) {
  const teamChartRef = useRef(null);
  if (!dashboard) return null;

  const { teamMetrics, personMetrics = [], burndown, dailyHours } = dashboard;
  const teamLineData = useMemo(() => {
    const base = burndown?.team || [];
    const dayCapacity = (dashboard.workingDays || []).map((_, i) =>
      (dailyHours?.people || []).reduce((sum, person) => sum + (person.cells?.[i]?.capacity || 0), 0),
    );
    let remainingCapacity = dayCapacity.reduce((sum, v) => sum + v, 0);
    return base.map((d, i) => {
      remainingCapacity = Math.max(0, remainingCapacity - (dayCapacity[i] || 0));
      return { ...d, label: shortDay(d.day), availableCapacity: fmt(remainingCapacity) };
    });
  }, [burndown?.team, dashboard.workingDays, dailyHours?.people]);

  const peopleCards = useMemo(() => {
    const byMetricName = new Map(personMetrics.map((p) => [p.name, p]));
    const byDailyName = new Map((dailyHours?.people || []).map((p) => [p.name, p]));
    const burndownPeople = burndown?.people || [];

    return burndownPeople
      .map((p) => {
        if (isUnassigned(p.name)) return null;
        const metrics = byMetricName.get(p.name);
        const daily = byDailyName.get(p.name);
        if (!metrics) return null;
        const series = (dashboard.workingDays || []).map((day, i) => ({
          day,
          label: shortDay(day),
          remaining: p.remaining?.[i]?.hours ?? null,
          completed: p.completed?.[i]?.hours ?? null,
          worked: daily?.cells?.[i]?.worked ?? 0,
          burned: daily?.cells?.[i]?.burned ?? 0,
        }));
        return { name: p.name, metrics, series };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (b.metrics.burnedToDate !== a.metrics.burnedToDate) return b.metrics.burnedToDate - a.metrics.burnedToDate;
        return a.name.localeCompare(b.name);
      });
  }, [dashboard.workingDays, burndown?.people, dailyHours?.people, personMetrics]);

  function exportTeamCsv() {
    const rows = [
      ['Day', 'Remaining', 'Ideal', 'Available capacity'],
      ...teamLineData.map((d) => [d.day, d.remaining, d.ideal, d.availableCapacity]),
    ];
    exportCsv('team-burndown.csv', rows);
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h3>Team Sprint Analytics</h3>
        </div>
        <div className="metric-grid">
          <div className="metric-card"><div className="metric-label">Working days elapsed</div><div className="metric-value">{teamMetrics?.elapsedWorkingDays}/{teamMetrics?.totalWorkingDays}</div></div>
          <div className="metric-card"><div className="metric-label">Working days remaining</div><div className="metric-value">{teamMetrics?.remainingWorkingDays ?? '—'}</div></div>
          <div className="metric-card"><div className="metric-label">Active contributors</div><div className="metric-value">{teamMetrics?.contributorsActive ?? '—'}</div></div>
          <div className="metric-card"><div className="metric-label">Worked to date</div><div className="metric-value">{fmt(teamMetrics?.workedToDate)}h</div></div>
          <div className="metric-card"><div className="metric-label">Burned to date</div><div className="metric-value">{fmt(teamMetrics?.burnedToDate)}h</div></div>
          <div className="metric-card"><div className="metric-label">Remaining today</div><div className="metric-value">{teamMetrics?.remainingToday == null ? '—' : `${fmt(teamMetrics?.remainingToday)}h`}</div></div>
          <div className="metric-card"><div className="metric-label">Burn efficiency</div><div className="metric-value">{pct(teamMetrics?.burnEfficiencyPct)}</div></div>
          <div className="metric-card"><div className="metric-label">Scope added to date</div><div className="metric-value">{fmt(teamMetrics?.scopeAddedToDate)}h</div></div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Team Burndown</h3>
          <div className="btn-row">
            <button onClick={exportTeamCsv}>CSV</button>
            <button onClick={() => exportPng(teamChartRef.current, 'team-burndown.png')}>PNG</button>
          </div>
        </div>
        <div ref={teamChartRef} className="chart-box">
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={teamLineData} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} label={{ value: 'Hours', angle: -90, position: 'insideLeft', fontSize: 12 }} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="remaining" name="Remaining" stroke="#2563eb" strokeWidth={2} dot={{ r: 2 }} />
              <Line
                type="monotone"
                dataKey="availableCapacity"
                name="Available capacity"
                stroke="#4ade80"
                strokeOpacity={0.7}
                strokeWidth={1.5}
                dot={false}
              />
              <Line type="monotone" dataKey="ideal" name="Ideal" stroke="#9ca3af" strokeDasharray="6 4" dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Per-Person Sprint Cards <span className="muted">({peopleCards.length})</span></h3>
        </div>
        <div className="person-card-grid">
          {peopleCards.map((p) => (
            <div className="person-card" key={p.name}>
              <div className="person-card-head">
                <h4>{p.name}</h4>
                <span className="pill">{pct(p.metrics.burnEfficiencyPct)} burn eff</span>
              </div>

              <div className="person-mini-metrics">
                <div><span className="muted">Cap/day</span><strong>{fmt(p.metrics.capacityPerDay)}</strong></div>
                <div><span className="muted">Worked</span><strong>{fmt(p.metrics.workedToDate)}h</strong></div>
                <div><span className="muted">Burned</span><strong>{fmt(p.metrics.burnedToDate)}h</strong></div>
                <div><span className="muted">Remaining</span><strong>{p.metrics.remainingToday == null ? '—' : `${fmt(p.metrics.remainingToday)}h`}</strong></div>
                <div><span className="muted">Completed</span><strong>{fmt(p.metrics.completedToDate)}h</strong></div>
                <div><span className="muted">Avg worked/day</span><strong>{fmt(p.metrics.avgWorkedPerDay)}h</strong></div>
                <div><span className="muted">Avg burned/day</span><strong>{fmt(p.metrics.avgBurnedPerDay)}h</strong></div>
              </div>

              <div className="person-chart">
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={p.series} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend />
                    <Bar yAxisId="right" dataKey="worked" name="Worked/day" fill="#93c5fd" />
                    <Bar yAxisId="right" dataKey="burned" name="Burned/day" fill="#fdba74" />
                    <Line yAxisId="left" type="monotone" dataKey="remaining" name="Remaining" stroke="#2563eb" strokeWidth={2} dot={false} />
                    <Line yAxisId="left" type="monotone" dataKey="completed" name="Completed" stroke="#16a34a" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          ))}
          {!peopleCards.length && (
            <div className="muted">No person sprint metrics available for this team/iteration yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}

import React from 'react';
import { exportCsv } from '../utils/exports.js';

function fmtPct(v) {
  return v == null ? '—' : `${v}%`;
}

export default function TeamMetrics({ metrics }) {
  if (!metrics) return null;

  const cards = [
    { label: 'Working days elapsed', value: `${metrics.elapsedWorkingDays}/${metrics.totalWorkingDays}` },
    { label: 'Working days remaining', value: metrics.remainingWorkingDays },
    { label: 'Active contributors', value: metrics.contributorsActive },
    { label: 'Tasks in sprint scope', value: metrics.taskCount },
    { label: 'Worked to date (hrs)', value: metrics.workedToDate },
    { label: 'Burned to date (hrs)', value: metrics.burnedToDate },
    { label: 'Remaining today (hrs)', value: metrics.remainingToday == null ? '—' : metrics.remainingToday },
    { label: 'Burn efficiency', value: fmtPct(metrics.burnEfficiencyPct) },
    { label: 'Capacity utilization', value: fmtPct(metrics.utilizationPct) },
    { label: 'Scope added (hrs)', value: metrics.scopeAddedToDate },
    { label: 'Tasks touched', value: metrics.tasksTouchedCount },
    { label: 'Metrics through', value: metrics.generatedThrough || '—' },
  ];

  function download() {
    const rows = [
      ['Metric', 'Value'],
      ...cards.map((c) => [c.label, c.value]),
    ];
    exportCsv('team-metrics.csv', rows);
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>Team Sprint Metrics</h3>
        <button onClick={download}>Export CSV</button>
      </div>
      <div className="metric-grid">
        {cards.map((c) => (
          <div className="metric-card" key={c.label}>
            <div className="metric-label">{c.label}</div>
            <div className="metric-value">{c.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

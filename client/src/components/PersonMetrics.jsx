import React from 'react';
import { exportCsv } from '../utils/exports.js';

function fmtPct(v) {
  return v == null ? '—' : `${v}%`;
}

export default function PersonMetrics({ metrics }) {
  if (!metrics) return null;

  function download() {
    const rows = [
      [
        'Person',
        'Capacity/day',
        'Capacity to date',
        'Worked to date',
        'Burned to date',
        'Remaining today',
        'Completed to date',
        'Utilization %',
        'Burn efficiency %',
        'Avg worked/day',
        'Avg burned/day',
        'Worked days',
        'Burned days',
        'Over/under to date',
        'Tasks touched',
      ],
      ...metrics.map((p) => ([
        p.name,
        p.capacityPerDay,
        p.capacityToDate,
        p.workedToDate,
        p.burnedToDate,
        p.remainingToday,
        p.completedToDate,
        p.utilizationPct == null ? '' : p.utilizationPct,
        p.burnEfficiencyPct == null ? '' : p.burnEfficiencyPct,
        p.avgWorkedPerDay,
        p.avgBurnedPerDay,
        p.workedDays,
        p.burnedDays,
        p.overUnderToDate,
        p.tasksTouched,
      ])),
    ];
    exportCsv('person-metrics.csv', rows);
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>Per-Person Sprint Metrics <span className="muted">({metrics.length})</span></h3>
        <button onClick={download} disabled={!metrics.length}>Export CSV</button>
      </div>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th className="num">Cap/day</th>
              <th className="num">Cap to date</th>
              <th className="num">Worked</th>
              <th className="num">Burned</th>
              <th className="num">Remaining</th>
              <th className="num">Completed</th>
              <th className="num">Util %</th>
              <th className="num">Burn eff %</th>
              <th className="num">Avg worked/day</th>
              <th className="num">Avg burned/day</th>
              <th className="num">Worked days</th>
              <th className="num">Burned days</th>
              <th className="num">Over/under</th>
              <th className="num">Tasks touched</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((p) => (
              <tr key={p.name}>
                <td>{p.name}</td>
                <td className="num">{p.capacityPerDay}</td>
                <td className="num">{p.capacityToDate}</td>
                <td className="num">{p.workedToDate}</td>
                <td className="num">{p.burnedToDate}</td>
                <td className="num">{p.remainingToday}</td>
                <td className="num">{p.completedToDate}</td>
                <td className="num">{fmtPct(p.utilizationPct)}</td>
                <td className="num">{fmtPct(p.burnEfficiencyPct)}</td>
                <td className="num">{p.avgWorkedPerDay}</td>
                <td className="num">{p.avgBurnedPerDay}</td>
                <td className="num">{p.workedDays}</td>
                <td className="num">{p.burnedDays}</td>
                <td className={`num ${p.overUnderToDate > 0 ? 'eff-over' : p.overUnderToDate < 0 ? 'eff-under' : ''}`}>
                  {p.overUnderToDate}
                </td>
                <td className="num">{p.tasksTouched}</td>
              </tr>
            ))}
            {!metrics.length && <tr><td colSpan={15} className="muted center">No person metrics found.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

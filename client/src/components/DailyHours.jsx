import React, { useState, useMemo } from 'react';
import { exportCsv } from '../utils/exports.js';

function shortDay(key) {
  const d = new Date(key + 'T00:00:00.000Z');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
}

function cellClass(cell, isFuture) {
  if (cell.off) return 'hcell off';
  if (isFuture) return 'hcell future';
  if (cell.capacity === 0) return 'hcell';
  if (cell.worked > cell.capacity + 0.01) return 'hcell over';
  if (cell.worked < cell.capacity - 0.01) return 'hcell under';
  return 'hcell ontrack';
}

// Burn efficiency = burned-to-date / worked-to-date. Near 100% is on track.
function effClass(eff) {
  if (eff == null) return '';
  if (eff > 110) return 'eff-over';
  if (eff < 80) return 'eff-under';
  return 'eff-ok';
}

const todayKey = () => new Date().toISOString().slice(0, 10);
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

export default function DailyHours({ dailyHours, capacityDiag }) {
  const [fallback, setFallback] = useState('');

  const people = useMemo(() => {
    const base = dailyHours?.people || [];
    const hrs = Number(fallback);
    const today = todayKey();

    const enriched = base.map((p) => {
      // Apply a manual capacity to any non-day-off cell that has no ADO capacity.
      const cells = hrs > 0
        ? p.cells.map((c) => (c.off || c.capacity > 0 ? c : { ...c, capacity: hrs }))
        : p.cells;

      const fullCapacity = round(cells.reduce((s, c) => s + c.capacity, 0));
      // Worked/burned counted only through today.
      const workedToDate = round(
        cells.reduce((s, c) => s + (c.day <= today ? c.worked : 0), 0),
      );
      const burnedToDate = round(
        cells.reduce((s, c) => s + (c.day <= today ? (c.burned || 0) : 0), 0),
      );
      const efficiency = workedToDate > 0 ? Math.round((burnedToDate / workedToDate) * 100) : null;

      return { ...p, cells, fullCapacity, totalWorked: workedToDate, burnedToDate, efficiency };
    });

    // Only show people who actually have capacity configured for the sprint.
    return enriched.filter((p) => p.fullCapacity > 0);
  }, [dailyHours, fallback]);

  if (!dailyHours) return null;
  const { days } = dailyHours;
  const today = todayKey();

  const noCapacity = (capacityDiag && capacityDiag.withCapacity === 0) ||
    people.length === 0;

  function download() {
    const header = [
      'Person',
      ...days.flatMap((d) => [`${shortDay(d)} Worked`, `${shortDay(d)} Burned`]),
      'Worked to date',
      'Burned to date',
      'Burn efficiency %',
    ];
    const rows = [header];
    for (const p of people) {
      rows.push([
        p.name,
        ...p.cells.flatMap((c) => (c.off ? ['OFF', 'OFF'] : [c.worked, c.burned || 0])),
        p.totalWorked, p.burnedToDate, p.efficiency == null ? '' : p.efficiency,
      ]);
    }
    exportCsv('daily-hours.csv', rows);
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>Daily Hours per Person <span className="muted">(worked vs. capacity)</span></h3>
        <button onClick={download} disabled={!people.length}>Export CSV</button>
      </div>

      {noCapacity && (
        <div className="notice">
          <strong>No capacity came back from Azure DevOps</strong> for team
          {' '}<em>{capacityDiag?.teamName}</em> on iteration <em>{capacityDiag?.iterationName}</em>
          {' '}({capacityDiag?.membersReturned ?? 0} member record(s) returned).
          <div className="muted" style={{ marginTop: 6 }}>
            Capacity is set per team, per iteration. In ADO open <em>Boards → Sprints → Capacity</em>
            {' '}for this team and sprint and confirm each person has hours/day set. Make sure the
            sprint selected here matches the one where capacity was entered. Until then, set a
            fallback below to compare worked hours against a flat daily target.
          </div>
          <div className="fallback">
            <label>
              Fallback hours/person/day
              <input
                type="number"
                min="0"
                step="0.5"
                value={fallback}
                onChange={(e) => setFallback(e.target.value)}
                placeholder="e.g. 6"
              />
            </label>
          </div>
        </div>
      )}

      <div className="legend">
        <span className="swatch ontrack" /> On capacity
        <span className="swatch under" /> Under
        <span className="swatch over" /> Over
        <span className="swatch off" /> Day off / weekend
      </div>
      <div className="table-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th className="sticky-col">Person</th>
              {days.map((d) => <th key={d} className="num">{shortDay(d)}</th>)}
              <th className="num total">Worked<br/><span className="muted">to date</span></th>
              <th className="num total">Burned<br/><span className="muted">to date</span></th>
              <th className="num total">Burn<br/><span className="muted">efficiency</span></th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.name}>
                <td className="sticky-col">{p.name}</td>
                {p.cells.map((c) => (
                  <td
                    key={c.day}
                    className={cellClass(c, c.day > today)}
                    title={`${c.worked}h worked / ${c.burned || 0}h burned / ${c.capacity}h capacity`}
                  >
                    {c.off ? '—' : (
                      <div className="hcell-split">
                        <div className="hcell-line"><span className="hcell-k">W</span><span>{round(c.worked)}</span></div>
                        <div className="hcell-line"><span className="hcell-k">B</span><span>{round(c.burned || 0)}</span></div>
                      </div>
                    )}
                  </td>
                ))}
                <td className="num total">{p.totalWorked}</td>
                <td className="num total">{p.burnedToDate}</td>
                <td className={`num total ${effClass(p.efficiency)}`}>
                  {p.efficiency == null ? '—' : `${p.efficiency}%`}
                </td>
              </tr>
            ))}
            {!people.length && <tr><td colSpan={days.length + 4} className="muted center">No capacity/people found.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

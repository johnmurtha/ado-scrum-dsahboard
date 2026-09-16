import React, { useState } from 'react';
import { exportCsv } from '../utils/exports.js';

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toISOString().slice(0, 10);
}

function FeatureTable({ title, features }) {
  function download() {
    const rows = [
      ['#', 'Feature', 'State', '% Complete (Story Points)', 'Points Done', 'Points Total', 'Hours Remaining', 'Hours Complete', 'Target Date'],
      ...features.map((f, i) => [
        i + 1, f.title, f.state, `${f.percentComplete}%`, f.storyPointsDone, f.storyPointsTotal,
        f.hoursRemaining, f.hoursComplete, fmtDate(f.targetDate),
      ]),
    ];
    exportCsv(`${title.replace(/\s+/g, '-').toLowerCase()}.csv`, rows);
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>{title} <span className="muted">({features.length})</span></h3>
        <button onClick={download} disabled={!features.length}>Export CSV</button>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Feature</th>
              <th>State</th>
              <th>% Complete (pts)</th>
              <th className="num">Hrs Remaining</th>
              <th className="num">Hrs Complete</th>
              <th>Target Date</th>
            </tr>
          </thead>
          <tbody>
            {features.map((f, i) => (
              <tr key={f.id}>
                <td className="num muted">{i + 1}</td>
                <td>{f.title}</td>
                <td><span className="pill">{f.state}</span></td>
                <td>
                  <div className="progress">
                    <div className="progress-bar" style={{ width: `${f.percentComplete}%` }} />
                    <span className="progress-label">
                      {f.percentComplete}% <span className="muted">({f.storyPointsDone}/{f.storyPointsTotal})</span>
                    </span>
                  </div>
                </td>
                <td className="num">{f.hoursRemaining}</td>
                <td className="num">{f.hoursComplete}</td>
                <td>{fmtDate(f.targetDate)}</td>
              </tr>
            ))}
            {!features.length && (
              <tr><td colSpan={7} className="muted center">No features.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function FeatureStatus({ data }) {
  const [view, setView] = useState('iteration');
  if (!data) return null;
  return (
    <div>
      <div className="tabs sub">
        <button className={view === 'iteration' ? 'active' : ''} onClick={() => setView('iteration')}>
          Current Iteration
        </button>
        <button className={view === 'backlog' ? 'active' : ''} onClick={() => setView('backlog')}>
          Full Backlog
        </button>
      </div>
      {view === 'iteration' ? (
        <FeatureTable title="Iteration Features" features={data.iterationFeatures} />
      ) : (
        <FeatureTable title="Backlog Features" features={data.backlogFeatures} />
      )}
    </div>
  );
}

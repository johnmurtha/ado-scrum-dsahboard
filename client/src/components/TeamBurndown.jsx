import React, { useRef } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { exportPng, exportCsv } from '../utils/exports.js';

function shortDay(key) {
  return new Date(key + 'T00:00:00.000Z').toLocaleDateString('en-US', {
    month: 'numeric', day: 'numeric', timeZone: 'UTC',
  });
}

export default function TeamBurndown({ team }) {
  const ref = useRef(null);
  if (!team) return null;
  const data = team.map((pt) => ({ ...pt, label: shortDay(pt.day) }));

  function csv() {
    exportCsv('team-burndown.csv', [
      ['Day', 'Remaining Hours', 'Ideal'],
      ...team.map((p) => [p.day, p.remaining, p.ideal]),
    ]);
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>Team Burndown <span className="muted">(remaining work hours)</span></h3>
        <div className="btn-row">
          <button onClick={csv}>CSV</button>
          <button onClick={() => exportPng(ref.current, 'team-burndown.png')}>PNG</button>
        </div>
      </div>
      <div ref={ref} className="chart-box">
        <ResponsiveContainer width="100%" height={340}>
          <LineChart data={data} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} label={{ value: 'Hours', angle: -90, position: 'insideLeft', fontSize: 12 }} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="remaining" name="Remaining" stroke="#2563eb" strokeWidth={2} dot={{ r: 2 }} />
            <Line type="monotone" dataKey="ideal" name="Ideal" stroke="#9ca3af" strokeDasharray="6 4" dot={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

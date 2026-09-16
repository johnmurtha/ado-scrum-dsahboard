import React, { useRef, useState, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { exportPng, exportCsv } from '../utils/exports.js';
import { colorForIndex } from '../utils/colors.js';

function shortDay(key) {
  return new Date(key + 'T00:00:00.000Z').toLocaleDateString('en-US', {
    month: 'numeric', day: 'numeric', timeZone: 'UTC',
  });
}

export default function PersonBurndown({ people, days }) {
  const ref = useRef(null);
  const [mode, setMode] = useState('remaining'); // 'remaining' | 'completed'

  // Only chart people who have capacity configured.
  const shown = useMemo(() => (people || []).filter((p) => (p.capacityPerDay || 0) > 0), [people]);

  const data = useMemo(() => {
    if (!shown.length) return [];
    return (days || []).map((day, i) => {
      const row = { label: shortDay(day) };
      for (const p of shown) {
        const series = mode === 'remaining' ? p.remaining : p.completed;
        row[p.name] = series[i]?.hours ?? null;
      }
      return row;
    });
  }, [shown, days, mode]);

  if (!people) return null;

  function csv() {
    const header = ['Day', ...shown.map((p) => p.name)];
    const rows = [header];
    (days || []).forEach((day, i) => {
      const series = (p) => (mode === 'remaining' ? p.remaining : p.completed)[i]?.hours ?? '';
      rows.push([day, ...shown.map(series)]);
    });
    exportCsv(`person-burndown-${mode}.csv`, rows);
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>
          Per-Person Burndown{' '}
          <span className="muted">({mode === 'remaining' ? 'remaining work hours' : 'cumulative hours completed'})</span>
        </h3>
        <div className="btn-row">
          <div className="tabs sub inline">
            <button className={mode === 'remaining' ? 'active' : ''} onClick={() => setMode('remaining')}>Remaining</button>
            <button className={mode === 'completed' ? 'active' : ''} onClick={() => setMode('completed')}>Completed</button>
          </div>
          <button onClick={csv}>CSV</button>
          <button onClick={() => exportPng(ref.current, `person-burndown-${mode}.png`)}>PNG</button>
        </div>
      </div>
      <div ref={ref} className="chart-box">
        <ResponsiveContainer width="100%" height={400}>
          <LineChart data={data} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} label={{ value: 'Hours', angle: -90, position: 'insideLeft', fontSize: 12 }} />
            <Tooltip />
            <Legend />
            {shown.map((p, i) => (
              <Line
                key={p.name}
                type="monotone"
                dataKey={p.name}
                stroke={colorForIndex(i)}
                strokeWidth={2}
                dot={{ r: 2 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

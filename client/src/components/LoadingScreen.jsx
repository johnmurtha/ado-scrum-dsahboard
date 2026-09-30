import React, { useEffect, useState } from 'react';

const MESSAGES = [
  'Connecting to Azure DevOps…',
  'Fetching iteration and capacity…',
  'Pulling tasks in sprint scope…',
  'Replaying task revision history…',
  'Reconstructing daily worked and burned hours…',
  'Tallying story points and velocity…',
  'Checking for work outside the sprint…',
  'Assembling your dashboard…',
];

// Bars animate in on a stagger to suggest a burndown filling in.
const BARS = [38, 52, 30, 64, 46, 72, 58, 80];

export default function LoadingScreen({ progress }) {
  const [msgIndex, setMsgIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setMsgIndex((i) => (i + 1) % MESSAGES.length), 2200);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const loaded = Number(progress?.loaded) || 0;
  const total = Number(progress?.total) || 0;
  const hasReal = total > 0;
  const pct = hasReal ? Math.min(100, Math.round((loaded / total) * 100)) : null;

  const detail = progress?.stage === 'merging'
    ? 'Merging results…'
    : hasReal
      ? `${Math.min(loaded, total)} of ${total} tasks`
      : 'Starting up…';

  return (
    <div className="loading-screen">
      <div className="loading-card">
        <div className="loading-chart" aria-hidden="true">
          <svg viewBox="0 0 320 120" preserveAspectRatio="none" className="loading-svg">
            <line className="loading-grid" x1="0" y1="30" x2="320" y2="30" />
            <line className="loading-grid" x1="0" y1="60" x2="320" y2="60" />
            <line className="loading-grid" x1="0" y1="90" x2="320" y2="90" />

            {BARS.map((h, i) => (
              <rect
                key={i}
                className="loading-bar"
                x={i * 40 + 12}
                y={120 - h}
                width="16"
                height={h}
                rx="3"
                style={{ animationDelay: `${i * 0.12}s` }}
              />
            ))}

            <path className="loading-ideal" d="M 8 12 L 312 112" />
            <path
              className="loading-line"
              d="M 8 16 C 60 28, 92 34, 128 52 S 196 66, 240 84 T 312 108"
            />
          </svg>
        </div>

        <div className="loading-title">Loading sprint data</div>
        <div className="loading-msg" key={msgIndex}>{MESSAGES[msgIndex]}</div>

        <div className={`loading-track${hasReal ? '' : ' indeterminate'}`}>
          <div
            className="loading-fill"
            style={hasReal ? { width: `${pct}%` } : undefined}
          />
        </div>

        <div className="loading-stats">
          <span>{detail}</span>
          <span>{pct == null ? `${elapsed}s` : `${pct}% · ${elapsed}s`}</span>
        </div>

        <div className="loading-note muted">
          Revision history is replayed task by task, so large sprints take a moment.
        </div>
      </div>

      <div className="loading-skeletons" aria-hidden="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <div className="skeleton-card" key={i} style={{ animationDelay: `${i * 0.1}s` }}>
            <div className="skeleton-line short" />
            <div className="skeleton-line tall" />
          </div>
        ))}
      </div>
    </div>
  );
}

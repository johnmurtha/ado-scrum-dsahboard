import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import ConnectionForm from './components/ConnectionForm.jsx';
import SprintOverview from './components/SprintOverview.jsx';
import LoadingScreen from './components/LoadingScreen.jsx';

export default function App() {
  const [conn, setConn] = useState(null); // { org, project, teams }
  const [team, setTeam] = useState('');
  const [iterations, setIterations] = useState([]);
  const [iterationId, setIterationId] = useState('');
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  // Restore the browser-session connection (e.g. after a page refresh).
  useEffect(() => {
    const saved = api.credentials();
    if (!saved?.org) return;
    api.teams()
      .then(({ teams }) => {
        if (teams?.length) setConn({ org: saved.org, project: saved.project, teams });
      })
      .catch(() => api.clearCredentials());
  }, []);

  async function onReady(res, teamName) {
    setConn(res);
    if (teamName) selectTeam(teamName);
  }

  async function selectTeam(name) {
    setTeam(name);
    setIterations([]);
    setIterationId('');
    setDashboard(null);
    setError(null);
    try {
      const { iterations } = await api.iterations(name);
      setIterations(iterations);
      const current = iterations.find((i) => i.timeFrame === 'current') || iterations[0];
      if (current) {
        setIterationId(current.id);
      } else {
        setError(`No iterations found for team "${name}".`);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function load() {
    if (!team || !iterationId) return;
    setLoading(true);
    setProgress(null);
    setError(null);
    try {
      const d = await api.dashboard(team, iterationId, setProgress);
      setDashboard(d);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  // Auto-load when team + iteration are chosen.
  useEffect(() => {
    if (team && iterationId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team, iterationId]);

  async function disconnect() {
    await api.disconnect();
    setConn(null);
    setTeam('');
    setIterations([]);
    setDashboard(null);
  }

  if (!conn) return <ConnectionForm onReady={onReady} />;

  const iteration = iterations.find((i) => i.id === iterationId);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">ADO Sprint Analytics Dashboard</div>
        <div className="controls">
          <label>
            Team
            <select value={team} onChange={(e) => selectTeam(e.target.value)}>
              {conn.teams.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
            </select>
          </label>
          <label>
            Iteration
            <select value={iterationId} onChange={(e) => setIterationId(e.target.value)}>
              {iterations.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name}{it.timeFrame === 'current' ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </label>
          <button onClick={load} disabled={loading || !iterationId}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button className="ghost" onClick={disconnect}>Disconnect</button>
        </div>
      </header>

      <div className="meta">
        <span>{conn.org} / {conn.project}</span>
        {iteration?.startDate && (
          <span className="muted">
            {iteration.startDate.slice(0, 10)} → {iteration.finishDate?.slice(0, 10)}
          </span>
        )}
        {dashboard && <span className="muted">{dashboard.taskCount} tasks · reconstructed from revision history</span>}
      </div>

      {error && <div className="error banner">{error}</div>}
      {loading && <LoadingScreen progress={progress} />}

      {!loading && (
        <main className="content">
          {dashboard ? (
            <SprintOverview dashboard={dashboard} />
          ) : (
            <div className="card">
              <div className="muted">
                No sprint data loaded. Pick a team and iteration, then click Refresh.
              </div>
            </div>
          )}
        </main>
      )}
    </div>
  );
}

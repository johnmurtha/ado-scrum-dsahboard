import React, { useState } from 'react';
import { api } from '../api.js';

export default function ConnectionForm({ onReady }) {
  const [org, setOrg] = useState('');
  const [project, setProject] = useState('');
  const [pat, setPat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Step 2 state
  const [conn, setConn] = useState(null); // { org, project, teams }
  const [team, setTeam] = useState('');

  async function connect(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.connect({ org, project, pat });
      if (!res.teams?.length) throw new Error('Connected, but no teams were found in this project.');
      setConn(res);
      setTeam(res.teams[0].name);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function openDashboard(e) {
    e.preventDefault();
    onReady(conn, team);
  }

  async function back() {
    setConn(null);
    setTeam('');
    await api.disconnect().catch(() => {});
  }

  return (
    <div className="connect-wrap">
      {!conn ? (
        <form className="card connect-card" onSubmit={connect}>
          <h1>ADO Scrum Dashboard</h1>
          <p className="muted">
            Connect with an Azure DevOps Personal Access Token. The PAT is held only in the
            local server's memory for this session and never written to disk.
          </p>

          <label>
            Organization
            <input
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              placeholder="my-org or https://dev.azure.com/my-org"
              autoFocus
            />
          </label>

          <label>
            Project
            <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="My Project" />
          </label>

          <label>
            Personal Access Token
            <input
              type="password"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
              placeholder="PAT with Work Items (Read) + Analytics (Read)"
            />
          </label>

          {error && <div className="error">{error}</div>}

          <button className="primary" disabled={busy}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
          <p className="hint">
            Recommended scopes: <strong>Work Items (Read)</strong> and <strong>Analytics (Read)</strong>.
          </p>
        </form>
      ) : (
        <form className="card connect-card" onSubmit={openDashboard}>
          <h1>Choose a team</h1>
          <p className="muted">
            Connected to <strong>{conn.org} / {conn.project}</strong>. Pick a team to load. All
            queries are scoped to the team's area path, so large projects load quickly.
          </p>

          <label>
            Team
            <select value={team} onChange={(e) => setTeam(e.target.value)} autoFocus>
              {conn.teams.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
            </select>
          </label>

          {error && <div className="error">{error}</div>}

          <button className="primary" disabled={!team}>Open dashboard</button>
          <button type="button" className="ghost link" onClick={back}>← Back to connection</button>
        </form>
      )}
    </div>
  );
}

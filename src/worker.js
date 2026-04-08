// Internet Tracker — Cloudflare Worker + D1
// Tracks when you toggle internet on/off via iPhone Shortcuts

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers for dashboard
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // --- API Routes ---
      if (url.pathname === '/api/event' && request.method === 'POST') {
        return handlePostEvent(request, env, corsHeaders);
      }

      if (url.pathname === '/api/events' && request.method === 'GET') {
        return handleGetEvents(url, env, corsHeaders);
      }

      if (url.pathname === '/api/stats' && request.method === 'GET') {
        return handleGetStats(url, env, corsHeaders);
      }

      if (url.pathname === '/api/calendar' && request.method === 'GET') {
        return handleGetCalendar(url, env, corsHeaders);
      }

      // --- Dashboard ---
      if (url.pathname === '/' || url.pathname === '/dashboard') {
        return new Response(getDashboardHTML(), {
          headers: { 'Content-Type': 'text/html;charset=UTF-8' },
        });
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  },
};

// ─── Auth helper ───────────────────────────────────────────
function authenticate(request, env) {
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (token !== env.AUTH_TOKEN) {
    throw new Error('Unauthorized');
  }
}

// ─── POST /api/event ───────────────────────────────────────
// Body: { "type": "on" | "off", "source"?: string }
async function handlePostEvent(request, env, corsHeaders) {
  try {
    authenticate(request, env);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const body = await request.json();
  const eventType = body.type;

  if (!['on', 'off'].includes(eventType)) {
    return new Response(JSON.stringify({ error: 'type must be "on" or "off"' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const now = new Date();
  const timestamp = now.toISOString();
  const local = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const date = local.toISOString().substring(0, 10);
  const source = eventType === 'on' ? (body.source || 'Quick Catch Up') : null;

  await env.DB.prepare(
    'INSERT INTO events (event_type, timestamp, date, source) VALUES (?, ?, ?, ?)'
  )
    .bind(eventType, timestamp, date, source)
    .run();

  return new Response(
    JSON.stringify({ success: true, event_type: eventType, timestamp, date, source }),
    {
      status: 201,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    }
  );
}

// ─── GET /api/events?date=YYYY-MM-DD ──────────────────────
async function handleGetEvents(url, env, corsHeaders) {
  const date = url.searchParams.get('date') || new Date().toISOString().substring(0, 10);

  const { results } = await env.DB.prepare(
    'SELECT id, event_type, timestamp, date, source FROM events WHERE date = ? ORDER BY timestamp ASC'
  )
    .bind(date)
    .all();

  return new Response(JSON.stringify({ date, events: results }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// ─── Shared: compute on/off segments from events ─────────
function computeSegments(events, countOpenSegment = false) {
  const segments = [];
  let onTime = null;
  let onSource = null;
  let totalOnMs = 0;

  for (const evt of events) {
    if (evt.event_type === 'on') {
      onTime = evt.timestamp;
      onSource = evt.source || null;
    } else if (evt.event_type === 'off' && onTime) {
      const durationMs = new Date(evt.timestamp) - new Date(onTime);
      segments.push({ start: onTime, end: evt.timestamp, duration_ms: durationMs, source: onSource });
      if (!onSource || onSource === 'Quick Catch Up') totalOnMs += durationMs;
      onTime = null;
      onSource = null;
    }
  }

  if (onTime && countOpenSegment) {
    const durationMs = new Date() - new Date(onTime);
    segments.push({ start: onTime, end: null, duration_ms: durationMs, source: onSource });
    if (!onSource || onSource === 'Quick Catch Up') totalOnMs += durationMs;
  }

  return { segments, totalOnMs };
}

// ─── GET /api/stats?date=YYYY-MM-DD ──────────────────────
// Returns computed on/off segments and totals for the day
async function handleGetStats(url, env, corsHeaders) {
  const date = url.searchParams.get('date') || new Date().toISOString().substring(0, 10);

  const { results } = await env.DB.prepare(
    'SELECT event_type, timestamp, source FROM events WHERE date = ? ORDER BY timestamp ASC'
  )
    .bind(date)
    .all();

  const isToday = date === new Date().toISOString().substring(0, 10);
  const { segments, totalOnMs } = computeSegments(results, isToday);

  return new Response(
    JSON.stringify({
      date,
      segments,
      total_on_ms: totalOnMs,
      total_on_minutes: Math.round(totalOnMs / 60000),
      event_count: results.length,
    }),
    {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    }
  );
}

// ─── GET /api/calendar?month=YYYY-MM ─────────────────────
// Returns total online minutes per day for the given month
async function handleGetCalendar(url, env, corsHeaders) {
  const now = new Date();
  const month = url.searchParams.get('month') ||
    now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');

  const startDate = month + '-01';
  const [year, mon] = month.split('-').map(Number);
  const lastDay = new Date(year, mon, 0).getDate();
  const endDate = month + '-' + String(lastDay).padStart(2, '0');

  const { results } = await env.DB.prepare(
    'SELECT event_type, timestamp, date, source FROM events WHERE date >= ? AND date <= ? ORDER BY date ASC, timestamp ASC'
  )
    .bind(startDate, endDate)
    .all();

  // Group events by date
  const byDate = {};
  for (const evt of results) {
    if (!byDate[evt.date]) byDate[evt.date] = [];
    byDate[evt.date].push(evt);
  }

  // Compute online minutes per day
  const todayKey = now.toISOString().substring(0, 10);
  const days = {};
  for (let d = 1; d <= lastDay; d++) {
    const dateKey = month + '-' + String(d).padStart(2, '0');
    const events = byDate[dateKey] || [];
    const { totalOnMs } = computeSegments(events, dateKey === todayKey);

    days[dateKey] = {
      total_on_minutes: Math.round(totalOnMs / 60000),
      event_count: events.length,
    };
  }

  return new Response(
    JSON.stringify({ month, days }),
    { headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
}

// ─── Dashboard HTML ────────────────────────────────────────
function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Internet Tracker</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=DM+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --surface-2: #1a1a26;
    --border: #2a2a3a;
    --text: #e8e8f0;
    --text-dim: #6a6a80;
    --text-muted: #44445a;
    --accent: #22d68a;
    --accent-glow: rgba(34, 214, 138, 0.15);
    --accent-dim: #1a9e68;
    --off-surface: rgba(255, 255, 255, 0.03);
    --danger: #e05555;
    --focus: #5b8def;
    --focus-glow: rgba(91, 141, 239, 0.15);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'DM Sans', sans-serif;
    min-height: 100vh;
    overflow-x: hidden;
  }

  .container {
    max-width: 800px;
    margin: 0 auto;
    padding: 40px 24px 80px;
  }

  /* ─── Header ─── */
  header {
    margin-bottom: 48px;
  }

  header h1 {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: var(--text-dim);
    margin-bottom: 12px;
  }

  .date-display {
    font-size: 32px;
    font-weight: 700;
    letter-spacing: -0.5px;
    margin-bottom: 8px;
  }

  .date-nav {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 16px;
  }

  .date-nav button {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text-dim);
    padding: 8px 14px;
    border-radius: 8px;
    cursor: pointer;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    transition: all 0.2s;
  }

  .date-nav button:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .date-nav .today-btn {
    background: var(--accent-glow);
    border-color: var(--accent-dim);
    color: var(--accent);
  }

  /* ─── Stats Cards ─── */
  .stats-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    margin-bottom: 40px;
  }

  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
  }

  .stat-card .label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 8px;
  }

  .stat-card .value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 28px;
    font-weight: 700;
    color: var(--text);
  }

  .stat-card .value .unit {
    font-size: 13px;
    font-weight: 400;
    color: var(--text-dim);
    margin-left: 2px;
  }

  .stat-card.accent .value {
    color: var(--accent);
  }

  /* ─── Timeline ─── */
  .section-title {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 20px;
  }

  .timeline-container {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 28px 24px 20px;
    margin-bottom: 40px;
  }

  .timeline-bar-wrap {
    position: relative;
    height: 48px;
    margin-bottom: 12px;
  }

  .timeline-bar {
    position: relative;
    width: 100%;
    height: 48px;
    background: var(--off-surface);
    border-radius: 10px;
    overflow: hidden;
  }

  .timeline-segment {
    position: absolute;
    top: 0;
    height: 100%;
    background: var(--accent);
    opacity: 0.85;
    transition: opacity 0.2s;
    min-width: 2px;
  }

  .timeline-segment:hover {
    opacity: 1;
  }

  .timeline-segment.focus {
    background: var(--focus);
  }

  .timeline-segment.active {
    background: repeating-linear-gradient(
      90deg,
      var(--accent) 0px,
      var(--accent) 8px,
      var(--accent-dim) 8px,
      var(--accent-dim) 16px
    );
    background-size: 16px 100%;
    animation: barberpole 0.8s linear infinite;
  }

  .timeline-segment.focus.active {
    background: repeating-linear-gradient(
      90deg,
      var(--focus) 0px,
      var(--focus) 8px,
      rgba(91, 141, 239, 0.5) 8px,
      rgba(91, 141, 239, 0.5) 16px
    );
    background-size: 16px 100%;
  }

  @keyframes barberpole {
    from { background-position: 0 0; }
    to { background-position: 16px 0; }
  }

  .timeline-hours {
    display: flex;
    justify-content: space-between;
    padding: 0 2px;
  }

  .timeline-hours span {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: var(--text-muted);
  }

  /* tooltip */
  .timeline-tooltip {
    display: none;
    position: absolute;
    top: -44px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 10px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--text);
    white-space: nowrap;
    z-index: 10;
    pointer-events: none;
    transform: translateX(-50%);
  }

  .timeline-segment:hover .timeline-tooltip {
    display: block;
  }

  /* ─── Events Log ─── */
  .events-log {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 24px;
    margin-bottom: 40px;
  }

  .event-row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 0;
    border-bottom: 1px solid rgba(255,255,255,0.04);
  }

  .event-row:last-child { border-bottom: none; }

  .event-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .event-dot.on {
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent-glow);
  }

  .event-dot.off {
    background: var(--danger);
  }

  .event-type {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1px;
    width: 40px;
  }

  .event-type.on { color: var(--accent); }
  .event-type.off { color: var(--danger); }

  .event-time {
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    color: var(--text-dim);
  }

  .event-source {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.5px;
    color: var(--focus);
    background: var(--focus-glow);
    padding: 3px 8px;
    border-radius: 4px;
  }

  .event-duration {
    margin-left: auto;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: var(--text-muted);
  }

  /* ─── Empty state ─── */
  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: var(--text-muted);
  }

  .empty-state .icon {
    font-size: 40px;
    margin-bottom: 16px;
    opacity: 0.4;
  }

  .empty-state p {
    font-size: 14px;
    line-height: 1.6;
  }

  /* ─── Loading ─── */
  .loading {
    text-align: center;
    padding: 60px;
    color: var(--text-muted);
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
  }

  .loading::after {
    content: '';
    animation: dots 1.5s infinite;
  }

  @keyframes dots {
    0%, 20% { content: ''; }
    40% { content: '.'; }
    60% { content: '..'; }
    80%, 100% { content: '...'; }
  }

  /* ─── Status indicator ─── */
  .current-status {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    border-radius: 20px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 1px;
    text-transform: uppercase;
  }

  .current-status.online {
    background: var(--accent-glow);
    color: var(--accent);
    border: 1px solid rgba(34, 214, 138, 0.2);
  }

  .current-status.offline {
    background: rgba(224, 85, 85, 0.1);
    color: var(--danger);
    border: 1px solid rgba(224, 85, 85, 0.15);
  }

  .status-pulse {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.8); }
  }

  /* ─── Calendar ─── */
  .calendar-container {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 24px;
    margin-bottom: 40px;
  }

  .calendar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
  }

  .calendar-header .month-label {
    font-family: 'DM Sans', sans-serif;
    font-size: 16px;
    font-weight: 600;
    color: var(--text);
  }

  .calendar-header button {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-dim);
    padding: 6px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    transition: all 0.2s;
  }

  .calendar-header button:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .calendar-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 4px;
  }

  .calendar-dow {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--text-muted);
    text-align: center;
    padding: 0 0 8px;
  }

  .calendar-day {
    aspect-ratio: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: var(--text-dim);
    position: relative;
    cursor: default;
    transition: outline 0.15s;
  }

  .calendar-day.empty {
    cursor: default;
  }

  .calendar-day.has-data {
    cursor: pointer;
  }

  .calendar-day.today {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    color: var(--text);
    font-weight: 600;
  }

  .calendar-day.selected {
    outline: 2px solid var(--text-dim);
    outline-offset: -2px;
  }

  .cal-tooltip {
    display: none;
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 10px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--text);
    white-space: nowrap;
    z-index: 10;
    pointer-events: none;
  }

  .calendar-day:hover .cal-tooltip {
    display: block;
  }

  .calendar-legend {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 12px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: var(--text-muted);
  }

  .legend-swatch {
    width: 12px;
    height: 12px;
    border-radius: 3px;
  }

  /* ─── Responsive ─── */
  @media (max-width: 600px) {
    .container { padding: 24px 16px 60px; }
    .date-display { font-size: 24px; }
    .stats-row { grid-template-columns: 1fr; }
    .stat-card .value { font-size: 22px; }
    .timeline-container { padding: 20px 16px 14px; }
    .calendar-day { font-size: 11px; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>Internet Tracker</h1>
    <div class="date-display" id="dateDisplay"></div>
    <div id="currentStatus"></div>
    <nav class="date-nav">
      <button onclick="changeDate(-1)">&larr; prev</button>
      <button class="today-btn" onclick="goToday()">today</button>
      <button onclick="changeDate(1)">next &rarr;</button>
    </nav>
  </header>

  <div class="stats-row" id="statsRow">
    <div class="stat-card accent">
      <div class="label">Online</div>
      <div class="value" id="statOnline">--</div>
    </div>
    <div class="stat-card">
      <div class="label">Sessions</div>
      <div class="value" id="statSessions">--</div>
    </div>
    <div class="stat-card">
      <div class="label">Events</div>
      <div class="value" id="statEvents">--</div>
    </div>
  </div>

  <div class="section-title">24-Hour Timeline</div>
  <div class="timeline-container">
    <div class="timeline-bar-wrap">
      <div class="timeline-bar" id="timelineBar"></div>
    </div>
    <div class="timeline-hours">
      <span>00</span><span>03</span><span>06</span><span>09</span>
      <span>12</span><span>15</span><span>18</span><span>21</span><span>24</span>
    </div>
  </div>

  <div class="section-title">Monthly Overview</div>
  <div class="calendar-container">
    <div class="calendar-header">
      <button onclick="changeMonth(-1)">&larr;</button>
      <span class="month-label" id="calMonthLabel"></span>
      <button onclick="changeMonth(1)">&rarr;</button>
    </div>
    <div class="calendar-grid" id="calendarGrid"></div>
    <div class="calendar-legend">
      <span>less</span>
      <div class="legend-swatch" style="background:rgba(34,214,138,0.08)"></div>
      <div class="legend-swatch" style="background:rgba(34,214,138,0.25)"></div>
      <div class="legend-swatch" style="background:rgba(34,214,138,0.50)"></div>
      <div class="legend-swatch" style="background:rgba(34,214,138,0.75)"></div>
      <div class="legend-swatch" style="background:rgba(34,214,138,1)"></div>
      <span>more</span>
    </div>
  </div>

  <div class="section-title">Event Log</div>
  <div class="events-log" id="eventsLog">
    <div class="loading">Loading</div>
  </div>
</div>

<script>
  let currentDate = new Date();
  const BASE = '';

  function formatDateKey(d) {
    return d.toISOString().substring(0, 10);
  }

  function formatDateDisplay(d) {
    return d.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
  }

  function changeDate(delta) {
    currentDate.setDate(currentDate.getDate() + delta);
    syncCalendarMonth();
    loadData();
  }

  function goToday() {
    currentDate = new Date();
    syncCalendarMonth();
    loadData();
  }

  function syncCalendarMonth() {
    const newMonth = currentDate.getMonth();
    const newYear = currentDate.getFullYear();
    if (newMonth !== calMonth || newYear !== calYear) {
      calMonth = newMonth;
      calYear = newYear;
      loadCalendar();
    } else {
      // Just re-render to update selected highlight
      const grid = document.getElementById('calendarGrid');
      if (grid.children.length > 0) loadCalendar();
    }
  }

  function formatDuration(ms) {
    if (ms < 60000) return Math.round(ms / 1000) + 's';
    if (ms < 3600000) return Math.round(ms / 60000) + 'm';
    const h = Math.floor(ms / 3600000);
    const m = Math.round((ms % 3600000) / 60000);
    return h + 'h ' + m + 'm';
  }

  const TZ_OFFSET_MS = 2 * 60 * 60 * 1000; // UTC+2

  function toLocal(isoStr) {
    return new Date(new Date(isoStr).getTime() + TZ_OFFSET_MS);
  }

  function formatTime(isoStr) {
    const d = toLocal(isoStr);
    return d.toISOString().substring(11, 19);
  }

  function timeToPercent(isoStr) {
    const d = toLocal(isoStr);
    const hours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
    return (hours / 24) * 100;
  }

  async function loadData() {
    const dateKey = formatDateKey(currentDate);
    document.getElementById('dateDisplay').textContent = formatDateDisplay(currentDate);

    try {
      const [statsRes, eventsRes] = await Promise.all([
        fetch(BASE + '/api/stats?date=' + dateKey),
        fetch(BASE + '/api/events?date=' + dateKey),
      ]);

      const stats = await statsRes.json();
      const eventsData = await eventsRes.json();

      renderStats(stats);
      renderTimeline(stats.segments);
      renderEvents(eventsData.events);
      renderStatus(eventsData.events);
    } catch (err) {
      console.error('Failed to load data:', err);
      document.getElementById('eventsLog').innerHTML =
        '<div class="empty-state"><div class="icon">⚠</div><p>Failed to load data.<br>Check your Worker deployment.</p></div>';
    }
  }

  function renderStats(stats) {
    const online = stats.total_on_ms || 0;
    document.getElementById('statOnline').innerHTML = formatDuration(online);
    document.getElementById('statSessions').textContent = stats.segments?.length || 0;
    document.getElementById('statEvents').textContent = stats.event_count || 0;
  }

  function renderStatus(events) {
    const el = document.getElementById('currentStatus');
    if (!events.length) {
      el.innerHTML = '';
      return;
    }
    const last = events[events.length - 1];
    const isOnline = last.event_type === 'on';
    el.innerHTML = '<div class="current-status ' + (isOnline ? 'online' : 'offline') + '">'
      + '<div class="status-pulse"></div>'
      + (isOnline ? 'Online' : 'Offline')
      + '</div>';
  }

  function renderTimeline(segments) {
    const bar = document.getElementById('timelineBar');
    bar.innerHTML = '';

    if (!segments || !segments.length) return;

    for (const seg of segments) {
      const startPct = timeToPercent(seg.start);
      const endTime = seg.end || new Date().toISOString();
      const endPct = timeToPercent(endTime);
      const width = Math.max(endPct - startPct, 0.3);

      const isFocus = seg.source && seg.source !== 'Quick Catch Up';
      const div = document.createElement('div');
      div.className = 'timeline-segment' + (isFocus ? ' focus' : '') + (seg.end === null ? ' active' : '');
      div.style.left = startPct + '%';
      div.style.width = width + '%';

      const tooltip = document.createElement('div');
      tooltip.className = 'timeline-tooltip';
      tooltip.textContent = (seg.source && seg.source !== 'Quick Catch Up' ? seg.source + ': ' : '')
        + formatTime(seg.start) + ' → '
        + (seg.end ? formatTime(seg.end) : 'now')
        + ' (' + formatDuration(seg.duration_ms) + ')';
      div.appendChild(tooltip);

      bar.appendChild(div);
    }
  }

  function renderEvents(events) {
    const log = document.getElementById('eventsLog');

    if (!events.length) {
      log.innerHTML = '<div class="empty-state">'
        + '<div class="icon">📡</div>'
        + '<p>No events recorded for this day.<br>Toggle your internet to start tracking!</p>'
        + '</div>';
      return;
    }

    // Compute durations on chronological order, then reverse for display
    const durations = {};
    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      if (evt.event_type === 'on') {
        const nextOff = events.slice(i + 1).find(e => e.event_type === 'off');
        if (nextOff) {
          durations[i] = formatDuration(new Date(nextOff.timestamp) - new Date(evt.timestamp));
        } else {
          durations[i] = 'active';
        }
      }
    }

    let html = '';
    for (let i = events.length - 1; i >= 0; i--) {
      const evt = events[i];
      const time = formatTime(evt.timestamp);
      const durationStr = durations[i] || '';

      html += '<div class="event-row">'
        + '<div class="event-dot ' + evt.event_type + '"></div>'
        + '<div class="event-type ' + evt.event_type + '">' + evt.event_type + '</div>'
        + '<div class="event-time">' + time + '</div>'
        + (evt.source && evt.source !== 'Quick Catch Up' ? '<div class="event-source">' + evt.source + '</div>' : '')
        + (durationStr ? '<div class="event-duration">' + durationStr + '</div>' : '')
        + '</div>';
    }

    log.innerHTML = html;
  }

  // ─── Calendar ───
  let calYear = currentDate.getFullYear();
  let calMonth = currentDate.getMonth(); // 0-indexed

  function changeMonth(delta) {
    calMonth += delta;
    if (calMonth > 11) { calMonth = 0; calYear++; }
    if (calMonth < 0) { calMonth = 11; calYear--; }
    loadCalendar();
  }

  function getMonthKey(y, m) {
    return y + '-' + String(m + 1).padStart(2, '0');
  }

  async function loadCalendar() {
    const monthKey = getMonthKey(calYear, calMonth);
    const label = new Date(calYear, calMonth, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    document.getElementById('calMonthLabel').textContent = label;

    try {
      const res = await fetch(BASE + '/api/calendar?month=' + monthKey);
      const data = await res.json();
      renderCalendar(data.days);
    } catch (err) {
      console.error('Failed to load calendar:', err);
    }
  }

  function renderCalendar(days) {
    const grid = document.getElementById('calendarGrid');
    const firstDay = new Date(calYear, calMonth, 1).getDay(); // 0=Sun
    const lastDate = new Date(calYear, calMonth + 1, 0).getDate();
    const todayKey = formatDateKey(new Date());
    const selectedKey = formatDateKey(currentDate);

    // Find max minutes for color scaling
    let maxMin = 0;
    for (const key in days) {
      if (days[key].total_on_minutes > maxMin) maxMin = days[key].total_on_minutes;
    }
    if (maxMin === 0) maxMin = 1;

    let html = '';
    // Day-of-week headers
    const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (const d of dows) {
      html += '<div class="calendar-dow">' + d + '</div>';
    }

    // Empty cells before first day
    for (let i = 0; i < firstDay; i++) {
      html += '<div class="calendar-day empty"></div>';
    }

    // Day cells
    for (let d = 1; d <= lastDate; d++) {
      const dateKey = getMonthKey(calYear, calMonth) + '-' + String(d).padStart(2, '0');
      const info = days[dateKey] || { total_on_minutes: 0, event_count: 0 };
      const mins = info.total_on_minutes;
      const ratio = mins / maxMin;

      let bg;
      if (mins === 0) {
        bg = 'rgba(255,255,255,0.03)';
      } else {
        const alpha = 0.15 + ratio * 0.85;
        bg = 'rgba(34,214,138,' + alpha.toFixed(2) + ')';
      }

      const isToday = dateKey === todayKey;
      const isSelected = dateKey === selectedKey;
      const classes = 'calendar-day'
        + (mins > 0 ? ' has-data' : '')
        + (isToday ? ' today' : '')
        + (isSelected ? ' selected' : '');

      const hours = Math.floor(mins / 60);
      const m = mins % 60;
      const tooltipText = hours > 0 ? hours + 'h ' + m + 'm' : mins + 'm';

      html += '<div class="' + classes + '" style="background:' + bg + '"'
        + " onclick=" + '"selectCalendarDay(' + "'" + dateKey + "'" + ')">'
        + d
        + (mins > 0 ? '<div class="cal-tooltip">' + tooltipText + '</div>' : '')
        + '</div>';
    }

    grid.innerHTML = html;
  }

  function selectCalendarDay(dateKey) {
    currentDate = new Date(dateKey + 'T12:00:00');
    loadData();
    loadCalendar();
  }

  // Auto-refresh every 60s if viewing today
  setInterval(() => {
    if (formatDateKey(currentDate) === formatDateKey(new Date())) {
      loadData();
    }
  }, 60000);

  loadData();
  loadCalendar();
</script>
</body>
</html>`;
}

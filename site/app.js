/*
 * status.redacted.gg
 *
 * Reads the public Upptime data of the status repository in the visitor's browser and redraws
 * every minute. No cookies, no trackers. The only thing it stores is a copy of the public incident
 * list for five minutes, so reloads stay within GitHub's limit of 60 API calls an hour per visitor.
 */
(() => {
  'use strict';

  // GitHub owner and repository of the checks. Every data URL and link on the page is built from it.
  const REPO = 'redactedLabs/status';

  const REPO_URL = `https://github.com/${REPO}`;
  const RAW = `https://raw.githubusercontent.com/${REPO}/master/history/`;
  const ISSUES_API = `https://api.github.com/repos/${REPO}/issues?labels=status&state=all&per_page=30`;
  const ISSUES_URL = `${REPO_URL}/issues?q=label%3Astatus`;

  const REFRESH_MS = 60 * 1000;
  const INCIDENTS_TTL_MS = 5 * 60 * 1000;
  const INCIDENTS_RETRY_MS = 2 * 60 * 1000;
  const TIMEOUT_MS = 15 * 1000;
  const DAYS = 90;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const LONG_MINUTES = 30; // a day with this much downtime or more shows red
  const CACHE_KEY = 'status-incidents-v1';
  const STATUSES = ['up', 'degraded', 'down'];

  const $ = (id) => document.getElementById(id);
  const el = {
    fresh: $('fresh'),
    freshText: $('fresh-text'),
    banner: $('banner'),
    bannerIcon: $('banner-icon'),
    bannerTitle: $('banner-title'),
    bannerDetail: $('banner-detail'),
    bannerIncidents: $('banner-incidents'),
    services: $('services'),
    incidents: $('incidents'),
    incidentsNote: $('incidents-note'),
    footText: $('foot-text'),
    year: $('year'),
    tip: $('tip'),
    live: $('live'),
  };

  const state = {
    sites: null, // history/summary.json
    live: {}, // slug -> history/<slug>.yml
    starts: {}, // slug -> time of the first check
    refreshedAt: 0,
    failedAt: 0,
    attemptAt: 0,
    signature: '',
  };
  // stale: a service changed its status since the list was last fetched
  const inc = { items: null, at: 0, next: 0, blockedUntil: 0, failed: false, stale: false };
  const dayLists = new Map(); // slug -> days of the last render, read by the tooltip
  const rendered = new Map(); // slug -> markup of the last render
  const last = {}; // markup of the last render per region
  let tipFor = null; // { bar, i }

  /* ---------- formatting */

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const nameList = (rows) => {
    const n = rows.map((r) => r.name);
    return n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
  };
  // all times in UTC, the same days the bars use
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (ms) => {
    const d = new Date(ms);
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  };
  const fmtDay = (ms) => `${WEEKDAYS[new Date(ms).getUTCDay()]} ${fmtDate(ms)}`;
  const stamp = (ms) => {
    const d = new Date(ms);
    return `${fmtDate(ms)}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
  };
  const timeTag = (ms) => `<time datetime="${new Date(ms).toISOString()}">${esc(stamp(ms))}</time>`;
  const startOfUtcDay = (ms) => ms - (ms % DAY_MS);
  const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

  function duration(minutes) {
    const min = Math.round(minutes);
    if (min < 1) return 'less than a minute';
    const d = Math.floor(min / 1440);
    const h = Math.floor((min % 1440) / 60);
    const m = min % 60;
    if (d) return h ? `${plural(d, 'day')} ${plural(h, 'hour')}` : plural(d, 'day');
    if (h) return m ? `${plural(h, 'hour')} ${plural(m, 'minute')}` : plural(h, 'hour');
    return plural(m, 'minute');
  }

  function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return `${Math.floor(s / 10) * 10} seconds ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${plural(m, 'minute')} ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${plural(h, 'hour')} ago`;
    return `${plural(Math.round(h / 24), 'day')} ago`;
  }

  /* ---------- data */

  async function get(url, type) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      // no-cache revalidates with the ETag, so an unchanged file comes back as a small 304
      const res = await fetch(url, { cache: 'no-cache', credentials: 'omit', signal: ctrl.signal });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { res });
      return type === 'text' ? await res.text() : await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // history/<slug>.yml is flat "key: value" lines
  function parseYml(text) {
    const out = {};
    for (const line of String(text).split('\n')) {
      const m = /^([A-Za-z]+):[ \t]*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
    return out;
  }

  async function loadStatus() {
    let fresh = false;
    try {
      const summary = await get(`${RAW}summary.json`);
      if (Array.isArray(summary) && summary.length) {
        state.sites = summary.filter((s) => s && typeof s.slug === 'string' && s.slug);
        fresh = true;
      }
    } catch (e) {
      // keep the copy from the last refresh
    }
    if (!state.sites) return false;
    const results = await Promise.allSettled(state.sites.map((s) => get(`${RAW}${encodeURIComponent(s.slug)}.yml`, 'text')));
    results.forEach((r, n) => {
      if (r.status !== 'fulfilled') return;
      const slug = state.sites[n].slug;
      const yml = parseYml(r.value);
      state.live[slug] = yml;
      const start = Date.parse(yml.startTime);
      if (start) state.starts[slug] = start;
      fresh = true;
    });
    return fresh;
  }

  function slim(issue) {
    return {
      number: issue.number,
      title: String(issue.title || ''),
      url: String(issue.html_url || ''),
      open: issue.state === 'open',
      created: Date.parse(issue.created_at),
      closed: issue.closed_at ? Date.parse(issue.closed_at) : null,
      labels: (issue.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean),
    };
  }

  function readCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (c && c.repo === REPO && typeof c.at === 'number' && Array.isArray(c.items)) {
        const items = c.items.filter((i) => i && typeof i.title === 'string' && Array.isArray(i.labels) && Number.isFinite(i.created));
        return { at: c.at, items };
      }
    } catch (e) {
      // storage blocked or unreadable
    }
    return null;
  }

  function writeCache(at, items) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ repo: REPO, at, items }));
    } catch (e) {
      // storage blocked or full
    }
  }

  // GitHub allows 60 unauthenticated API calls an hour per IP, so the list is asked for at most
  // every five minutes, or sooner (30 seconds apart at most) after a service changed its status.
  async function loadIncidents() {
    const due = () => Date.now() >= (inc.stale ? inc.at + REFRESH_MS / 2 : inc.next);
    if (Date.now() < inc.blockedUntil || !due()) return;
    const cached = inc.stale ? null : readCache(); // another tab may have fetched it already
    if (cached && cached.at > inc.at) {
      Object.assign(inc, { items: cached.items, at: cached.at, next: cached.at + INCIDENTS_TTL_MS, failed: false });
      if (!due()) return;
    }
    try {
      const data = await get(ISSUES_API);
      if (!Array.isArray(data)) throw new Error('unexpected answer');
      inc.items = data
        .filter((i) => i && !i.pull_request)
        .map(slim)
        .filter((i) => Number.isFinite(i.created));
      inc.at = Date.now();
      inc.next = inc.at + INCIDENTS_TTL_MS;
      inc.failed = false;
      inc.stale = false;
      writeCache(inc.at, inc.items);
    } catch (e) {
      inc.failed = true;
      inc.next = Date.now() + INCIDENTS_RETRY_MS;
      const res = e && e.res;
      if (res && (res.status === 403 || res.status === 429)) {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        const retry = Number(res.headers.get('retry-after')) * 1000;
        inc.blockedUntil = reset > Date.now() ? reset : Date.now() + (retry || 15 * 60 * 1000);
      }
    }
  }

  /* ---------- model */

  function rows() {
    return (state.sites || []).map((site) => {
      const live = state.live[site.slug] || {};
      const status = STATUSES.includes(live.status) ? live.status : STATUSES.includes(site.status) ? site.status : 'unknown';
      return { site, slug: site.slug, name: String(site.name || site.slug), status, live };
    });
  }

  const openIncidents = () => (inc.items || []).filter((i) => i.open);
  const isDegraded = (i) => /degraded/i.test(i.title);
  const cleanTitle = (t) => String(t).replace(/^[^\p{L}\p{N}]+/u, '').trim() || 'Incident';
  const issueUrl = (i) => (/^https:\/\/github\.com\//.test(i.url) ? i.url : `${REPO_URL}/issues/${encodeURIComponent(i.number)}`);

  function earliestStart() {
    const all = Object.values(state.starts);
    return all.length ? Math.min(...all) : null;
  }

  // One entry per UTC day, oldest first. dailyMinutesDown counts down and degraded time alike.
  function dayList(row, now) {
    const today = startOfUtcDay(now);
    const start = state.starts[row.slug] || earliestStart();
    const mins = row.site.dailyMinutesDown && typeof row.site.dailyMinutesDown === 'object' ? row.site.dailyMinutesDown : {};
    // summary.json is rewritten about once a day, so an ongoing incident is counted up to now
    let since = 0;
    if (row.status === 'down' || row.status === 'degraded') {
      const open = openIncidents().filter((i) => i.labels.includes(row.slug));
      since = open.length ? Math.min(...open.map((i) => i.created)) : Date.parse(row.live.lastUpdated) || 0;
    }
    const list = [];
    for (let n = 0; n < DAYS; n++) {
      const t = today - (DAYS - 1 - n) * DAY_MS;
      const counted = Math.max(0, Number(mins[dayKey(t)]) || 0);
      let minutes = counted;
      if (since) {
        const overlap = Math.min(now, t + DAY_MS) - Math.max(since, t);
        if (overlap > 0) minutes = Math.max(minutes, Math.max(1, Math.round(overlap / 60000)));
      }
      const before = start ? t + DAY_MS <= start : !minutes;
      const kind = before ? 'none' : !minutes ? 'up' : minutes >= LONG_MINUTES ? 'down' : 'warn';
      list.push({ t, minutes, counted, kind, today: n === DAYS - 1 });
    }
    return list;
  }

  // Same sum as Upptime's own figures: downtime over the time the service has been checked
  function uptime90(row, list, now) {
    const start = state.starts[row.slug];
    if (!start) return null;
    const checked = now - Math.max(start, list[0].t);
    if (checked <= 0) return null;
    const down = list.reduce((sum, d) => sum + d.counted, 0) * 60000;
    return `${Math.max(0, 100 - (down / checked) * 100).toFixed(2)}%`;
  }

  /* ---------- render */

  const PILLS = {
    up: ['pill-up', 'Operational'],
    degraded: ['pill-warn', 'Degraded'],
    down: ['pill-down', 'Down'],
    unknown: ['pill-unknown', 'Unknown'],
  };

  function serviceHtml(row, list, now) {
    const [pillClass, pillText] = PILLS[row.status];
    const bad = list.filter((d) => d.minutes > 0);
    const total = bad.reduce((sum, d) => sum + d.minutes, 0);
    let label = `${row.name}, last 90 days, ${bad.length ? `down on ${plural(bad.length, 'day')} for ${duration(total)} in total` : 'no downtime'}`;
    const start = state.starts[row.slug];
    if (start && start > list[0].t) label += `, checked since ${fmtDay(start)}`;
    const ms = Number(row.live.responseTime || row.site.time);
    const measured = Date.parse(row.live.lastUpdated);
    const stats = [
      ['24 h uptime', row.site.uptimeDay],
      ['7 d uptime', row.site.uptimeWeek],
      ['30 d uptime', row.site.uptimeMonth],
      ['90 d uptime', uptime90(row, list, now)],
      ['Response time', ms > 0 ? `${Math.round(ms).toLocaleString('en-US')} ms` : null],
    ]
      .map(([k, v], n) => `<div><dt>${k}</dt><dd${n === 4 && measured ? ` title="Measured ${esc(stamp(measured))}"` : ''}>${esc(v || 'No data')}</dd></div>`)
      .join('');
    return (
      `<div class="svc-head"><div class="svc-name"><h3>${esc(row.name)}</h3></div>` +
      `<span class="pill ${pillClass}">${pillText}</span></div>` +
      `<div class="bar" tabindex="0" role="group" aria-label="${esc(label)}" aria-describedby="bar-help">` +
      list.map((d, n) => `<span class="day d-${d.kind}" data-i="${n}"></span>`).join('') +
      '</div><div class="axis" aria-hidden="true"><span class="ax-90">90 days ago</span><span class="ax-60">60 days ago</span>' +
      '<span class="ax-30">30 days ago</span><span>Today</span></div>' +
      `<dl class="stats">${stats}</dl>`
    );
  }

  function renderServices(list, now) {
    if (!list.length) {
      if (state.failedAt) el.services.innerHTML = '<li class="svc svc-empty">The services could not be loaded. This page tries again every minute.</li>';
      return;
    }
    const kids = new Map([...el.services.children].map((li) => [li.dataset.slug || '', li]));
    let prev = null;
    for (const row of list) {
      const days = dayList(row, now);
      dayLists.set(row.slug, days);
      const html = serviceHtml(row, days, now);
      let li = kids.get(row.slug);
      kids.delete(row.slug);
      if (!li) {
        li = document.createElement('li');
        li.className = 'svc';
        li.dataset.slug = row.slug;
      }
      // replace only rows that changed, and keep keyboard focus and the open tooltip
      if (rendered.get(row.slug) !== html || !li.firstChild) {
        const hadFocus = li.contains(document.activeElement);
        const tipDay = tipFor && li.contains(tipFor.bar) ? tipFor.i : null;
        li.innerHTML = html;
        rendered.set(row.slug, html);
        const bar = li.querySelector('.bar');
        if (hadFocus) bar.focus({ preventScroll: true });
        if (tipDay !== null) showTip(bar, tipDay, false);
      }
      const ref = prev ? prev.nextSibling : el.services.firstChild;
      if (ref !== li) el.services.insertBefore(li, ref);
      prev = li;
    }
    kids.forEach((li) => li.remove());
  }

  const ICONS = {
    ok: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    warn: '<path d="M12 6.5v7M12 17.5v.01"/>',
    down: '<path d="M7 7l10 10M17 7L7 17"/>',
    loading: '<path d="M6.5 12h.01M12 12h.01M17.5 12h.01"/>',
    unknown: '<path d="M9.5 9.3a2.6 2.6 0 1 1 3.6 2.4c-.7.3-1.1.9-1.1 1.6v.4M12 17.5v.01"/>',
  };

  function renderBanner(list, open) {
    const total = list.length;
    const down = list.filter((r) => r.status === 'down');
    const slow = list.filter((r) => r.status === 'degraded');
    const up = list.filter((r) => r.status === 'up').length;
    let tone;
    let title;
    let detail = '';
    if (!total) {
      tone = state.failedAt ? 'unknown' : 'loading';
      title = state.failedAt ? 'The status data could not be loaded' : 'Checking the services';
      detail = state.failedAt
        ? `This page tries again every minute. The data is also public on <a href="${REPO_URL}">GitHub</a>.`
        : 'Loading the latest results.';
    } else {
      if (down.length) {
        tone = 'down';
        title = down.length === total ? 'All services are down' : down.length === 1 ? `${down[0].name} is down` : `${down.length} services are down`;
      } else if (slow.length) {
        tone = 'warn';
        title = slow.length === 1 ? `${slow[0].name} has degraded performance` : `${slow.length} services have degraded performance`;
      } else if (open.length) {
        tone = 'warn';
        title = open.length === 1 ? 'An incident is open' : `${open.length} incidents are open`;
      } else if (up === total) {
        tone = 'ok';
        title = 'All services are operational';
      } else {
        tone = 'unknown';
        title = 'Some results are missing';
      }
      if (tone !== 'ok') {
        const parts = [];
        if (down.length > 1 && down.length < total) parts.push(`${nameList(down)} are down.`);
        if (slow.length && (down.length || slow.length > 1)) parts.push(`${nameList(slow)} ${slow.length > 1 ? 'have' : 'has'} degraded performance.`);
        if (down.length < total) parts.push(`${up} of ${total} services are operational.`);
        detail = esc(parts.join(' '));
      }
    }
    const items = open
      .slice(0, 5)
      .map((i) => `<li><a href="${esc(issueUrl(i))}">${esc(cleanTitle(i.title))}</a>, started ${esc(ago(i.created))}</li>`)
      .join('');

    el.banner.className = `banner tone-${tone}`;
    if (last.tone !== tone) {
      el.bannerIcon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[tone]}</svg>`;
      last.tone = tone;
    }
    if (el.bannerTitle.textContent !== title) el.bannerTitle.textContent = title;
    if (last.detail !== detail) el.bannerDetail.innerHTML = last.detail = detail;
    if (last.bannerItems !== items) el.bannerIncidents.innerHTML = last.bannerItems = items;
  }

  function incidentHtml(i, now) {
    const [pillClass, pillText] = i.open ? [isDegraded(i) ? 'pill-warn' : 'pill-down', 'Open'] : ['pill-up', 'Resolved'];
    const end = i.closed || i.created;
    const meta = [`<span>Started ${timeTag(i.created)}</span>`];
    if (i.open) meta.push(`<span>Open for ${duration((now - i.created) / 60000)}</span>`);
    else meta.push(`<span>Resolved ${timeTag(end)}</span>`, `<span>Lasted ${duration((end - i.created) / 60000)}</span>`);
    return (
      `<li class="inc"><div class="inc-head"><a class="inc-title" href="${esc(issueUrl(i))}">${esc(cleanTitle(i.title))}</a>` +
      `<span class="pill ${pillClass}">${pillText}</span></div><p class="inc-meta">${meta.join('')}</p></li>`
    );
  }

  function renderIncidents(now) {
    let html;
    let note = '';
    if (!inc.items) {
      html = inc.failed
        ? `<p class="empty">The incident list could not be loaded right now. It is also on <a href="${ISSUES_URL}">GitHub</a>.</p>`
        : '<p class="empty">Loading incidents.</p>';
    } else {
      const cutoff = now - DAYS * DAY_MS;
      const open = inc.items.filter((i) => i.open).sort((a, b) => b.created - a.created);
      const past = inc.items.filter((i) => !i.open && (i.closed || i.created) >= cutoff).sort((a, b) => b.created - a.created);
      const all = open.concat(past);
      html = all.length
        ? `<ul class="incidents">${all.map((i) => incidentHtml(i, now)).join('')}</ul>`
        : '<p class="empty">No incidents in the last 90 days.</p>';
      note = inc.failed
        ? `This list could not be refreshed just now, so it may be behind. The full list is on <a href="${ISSUES_URL}">GitHub</a>.`
        : `Every incident is a GitHub issue, and the full list is on <a href="${ISSUES_URL}">GitHub</a>.`;
    }
    if (last.incidents !== html) el.incidents.innerHTML = last.incidents = html;
    if (last.note !== note) el.incidentsNote.innerHTML = last.note = note;
  }

  function renderFoot(list) {
    const newest = Math.max(0, ...list.map((r) => Date.parse(r.live.lastUpdated) || 0));
    const html =
      `Each service is checked about every five minutes from GitHub, and the full history is public in <a href="${REPO_URL}">${esc(REPO)}</a>.` +
      (newest ? ` Last update ${timeTag(newest)}.` : '');
    if (last.foot !== html) el.footText.innerHTML = last.foot = html;
  }

  function renderFresh() {
    let text;
    let cls = '';
    if (state.refreshedAt && state.refreshedAt >= state.failedAt) {
      text = `Refreshed ${ago(state.refreshedAt)}`;
    } else if (state.refreshedAt) {
      text = `Could not refresh, showing results from ${ago(state.refreshedAt)}`;
      cls = 'is-stale';
    } else if (state.failedAt) {
      text = 'Could not load the results, trying again every minute';
      cls = 'is-stale';
    } else {
      text = ''; // the banner already says it is loading
      cls = 'is-empty';
    }
    el.fresh.className = `fresh ${cls}`.trim();
    if (el.freshText.textContent !== text) el.freshText.textContent = text;
  }

  function render() {
    const now = Date.now();
    const list = rows();
    renderServices(list, now);
    renderBanner(list, openIncidents());
    renderIncidents(now);
    renderFoot(list);
    renderFresh();
  }

  /* ---------- day tooltip: mouse, touch and arrow keys */

  const mqWide = matchMedia('(min-width: 720px)');
  const mqMid = matchMedia('(min-width: 480px)');
  const firstVisible = () => (mqWide.matches ? 0 : mqMid.matches ? 30 : 60); // matches the CSS

  function dayInfo(slug, n) {
    const d = (dayLists.get(slug) || [])[n];
    if (!d) return null;
    let text;
    if (d.kind === 'none') text = 'No data';
    else if (!d.minutes) text = d.today ? 'No downtime so far' : 'No downtime';
    else {
      const hits = (inc.items || []).filter((i) => i.labels.includes(slug) && i.created < d.t + DAY_MS && (i.closed || Date.now()) > d.t);
      text = `${hits.length && hits.every(isDegraded) ? 'Degraded' : 'Down'} for ${duration(d.minutes)}`;
    }
    return { date: fmtDay(d.t), text };
  }

  function clearMark(bar) {
    bar.classList.remove('has-on');
    const on = bar.querySelector('.is-on');
    if (on) on.classList.remove('is-on');
  }

  function hideTip() {
    if (tipFor) clearMark(tipFor.bar);
    tipFor = null;
    el.tip.hidden = true;
  }

  function placeTip(day) {
    const r = day.getBoundingClientRect();
    const tip = el.tip;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const cx = r.left + r.width / 2;
    const left = Math.max(8, Math.min(cx - w / 2, document.documentElement.clientWidth - w - 8));
    let top = r.top - h - 10;
    const below = top < 8;
    if (below) top = r.bottom + 10;
    tip.classList.toggle('is-below', below);
    tip.style.left = `${Math.round(left + window.scrollX)}px`;
    tip.style.top = `${Math.round(top + window.scrollY)}px`;
    tip.style.setProperty('--ax', `${Math.round(cx - left)}px`);
  }

  function showTip(bar, n, announce) {
    const li = bar.closest('.svc');
    const info = li && dayInfo(li.dataset.slug, n);
    const day = bar.children[n];
    if (!info || !day) {
      hideTip();
      return;
    }
    if (tipFor && tipFor.bar !== bar) clearMark(tipFor.bar);
    clearMark(bar);
    bar.classList.add('has-on');
    day.classList.add('is-on');
    bar.dataset.active = String(n);
    el.tip.innerHTML = `<span class="tip-date">${esc(info.date)}</span><span class="tip-text">${esc(info.text)}</span>`;
    el.tip.hidden = false;
    placeTip(day);
    tipFor = { bar, i: n };
    if (announce) el.live.textContent = `${info.date}, ${info.text}`;
  }

  function dayAt(bar, clientX) {
    const from = firstVisible();
    const r = bar.getBoundingClientRect();
    const n = from + Math.floor(((clientX - r.left) / r.width) * (DAYS - from));
    return Math.max(from, Math.min(DAYS - 1, n));
  }

  const barOf = (node) => (node && node.closest ? node.closest('.bar') : null);

  el.services.addEventListener('pointermove', (e) => {
    const bar = barOf(e.target);
    if (!bar) return;
    const n = dayAt(bar, e.clientX);
    if (!tipFor || tipFor.bar !== bar || tipFor.i !== n) showTip(bar, n, false);
  });

  el.services.addEventListener('pointerout', (e) => {
    if (e.pointerType === 'touch') return;
    const bar = barOf(e.target);
    if (bar && !bar.contains(e.relatedTarget) && !bar.matches(':focus-visible')) hideTip();
  });

  document.addEventListener('pointerdown', (e) => {
    const bar = barOf(e.target);
    if (bar) showTip(bar, dayAt(bar, e.clientX), false);
    else if (tipFor) hideTip();
  });

  el.services.addEventListener('keydown', (e) => {
    const bar = e.target;
    if (!bar.classList || !bar.classList.contains('bar')) return;
    const from = firstVisible();
    const cur = tipFor && tipFor.bar === bar ? tipFor.i : DAYS - 1;
    let n;
    if (e.key === 'ArrowLeft') n = Math.max(from, cur - 1);
    else if (e.key === 'ArrowRight') n = Math.min(DAYS - 1, cur + 1);
    else if (e.key === 'Home') n = from;
    else if (e.key === 'End') n = DAYS - 1;
    else if (e.key === 'Escape') return hideTip();
    else return;
    e.preventDefault();
    showTip(bar, n, true);
  });

  el.services.addEventListener('focusin', (e) => {
    const bar = e.target;
    if (!bar.classList || !bar.classList.contains('bar') || (tipFor && tipFor.bar === bar)) return;
    const n = Number(bar.dataset.active);
    showTip(bar, Number.isInteger(n) && n >= firstVisible() ? n : DAYS - 1, false);
  });

  el.services.addEventListener('focusout', (e) => {
    if (tipFor && e.target === tipFor.bar) hideTip();
  });

  window.addEventListener('resize', hideTip);

  /* ---------- refresh loop: every minute while the page is visible */

  let timer = 0;
  let busy = false;

  function schedule() {
    clearTimeout(timer);
    if (!document.hidden) timer = setTimeout(refresh, Math.max(0, state.attemptAt + REFRESH_MS - Date.now()));
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    clearTimeout(timer);
    state.attemptAt = Date.now();
    try {
      let ok = false;
      try {
        ok = await loadStatus();
      } catch (e) {
        ok = false;
      }
      if (ok) state.refreshedAt = Date.now();
      else state.failedAt = Date.now();
      const signature = rows()
        .map((r) => `${r.slug}:${r.status}`)
        .join(',');
      if (state.signature && signature !== state.signature) inc.stale = true;
      state.signature = signature;
      render();
      await loadIncidents();
      render();
    } finally {
      busy = false;
      schedule();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(timer);
    } else {
      renderFresh();
      schedule(); // refreshes at once when the last try is more than a minute old
    }
  });
  window.addEventListener('online', refresh);
  setInterval(() => {
    if (!document.hidden) renderFresh();
  }, 10 * 1000);

  el.year.textContent = String(new Date().getUTCFullYear());
  const cached = readCache();
  if (cached) Object.assign(inc, { items: cached.items, at: cached.at, next: cached.at + INCIDENTS_TTL_MS });
  render();
  refresh();
})();

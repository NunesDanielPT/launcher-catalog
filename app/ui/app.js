// ShowKit — interface. Fala com o backend Rust através de invoke() do Tauri.
// Aberto num browser normal (sem Tauri) usa dados simulados, só para pré-visualizar.
(() => {
  'use strict';

  const TAURI = window.__TAURI__;
  const IS_TAURI = !!(TAURI && TAURI.core);
  const $ = (s, el = document) => el.querySelector(s);

  // ------------------------------------------------------------ simulação (pré-visualização no browser)
  const mockListeners = [];
  const mockInstalled = {
    playerslice: { version: '0.4.0', exe: 'C:\\Program Files\\PLAYERSLICE\\PLAYERSLICE.exe', location: 'C:\\Program Files\\PLAYERSLICE', uninstall: 'x' },
    mapsim: { version: '0.54.0', exe: 'C:\\MapSim\\MapSim.exe', location: 'C:\\MapSim', quiet: 'x' }
  };
  const mock = {
    async get_catalog() {
      const r = await fetch('/apps.json', { cache: 'no-store' });
      return { catalog: await r.json(), offline: false, fetched_at: Date.now() / 1000 };
    },
    async get_icon({ path }) { return '/' + path; },
    async get_release({ repo }) {
      await new Promise((r) => setTimeout(r, 250));
      const data = {
        'NunesDanielPT/VIDEOHOST-PLAYER': ['0.9.2', '2026-11-22T22:14:00Z', 'VIDEOHOST-PLAYER-Setup-0.9.2.exe', 48e6],
        'NunesDanielPT/PlayerSlice': ['0.4.1', '2026-11-22T21:59:35Z', 'PLAYERSLICE-Setup.exe', 52231509],
        'NunesDanielPT/MAPSIM-releases': ['0.54.0', '2026-11-21T17:40:25Z', 'MapSim-Setup.exe', 87662416],
        'NunesDanielPT/launcher-catalog': ['0.1.0', '2026-11-22T23:00:00Z', 'ShowKit-Setup.exe', 4e6]
      }[repo];
      if (!data && /^(storytold|tangency-labs|UCS-Care-Group)\//.test(repo)) {
        const id = repo.split('/')[1];
        return { version: '0.5.0', tag: 'v0.5.0', published_at: '2026-11-12T10:00:00Z', notes: '', html_url: `https://github.com/${repo}/releases`,
          asset_name: `${id}-0.5.0-windows-x64.msi`, asset_url: `https://github.com/${repo}/releases/download/v0.5.0/${id}-0.5.0-windows-x64.msi`,
          asset_size: 15e6 + id.length * 3e6, checked_at: Date.now() / 1000, stale: false };
      }
      if (!data) throw 'http:404';
      return {
        version: data[0], tag: 'v' + data[0], published_at: data[1], notes: '- Melhorias de estabilidade\n- Correções na interface',
        html_url: `https://github.com/${repo}/releases/tag/v${data[0]}`, asset_name: data[2],
        asset_url: `https://github.com/${repo}/releases/download/v${data[0]}/${data[2]}`, asset_size: data[3], checked_at: Date.now() / 1000, stale: false
      };
    },
    async get_installed() { return JSON.parse(JSON.stringify(mockInstalled)); },
    async install_app({ id, size }) {
      for (let i = 0; i <= 20; i++) {
        await new Promise((r) => setTimeout(r, 80));
        mockListeners.forEach((f) => f({ payload: { id, phase: 'download', received: (size * i) / 20, total: size } }));
      }
      mockListeners.forEach((f) => f({ payload: { id, phase: 'install', received: 0, total: 0 } }));
      await new Promise((r) => setTimeout(r, 900));
      const rel = S.releases[id];
      mockInstalled[id] = { version: rel.version, exe: 'C:\\x.exe', location: 'C:\\', uninstall: 'x' };
    },
    async uninstall_app({ id }) { await new Promise((r) => setTimeout(r, 900)); delete mockInstalled[id]; },
    async launch_app() {},
    async open_folder() {},
    async open_url({ url }) { window.open(url, '_blank'); },
    async app_info() { return { version: '0.1.0', windows: false }; },
    async self_update() {}
  };

  function call(cmd, args = {}) {
    return IS_TAURI ? TAURI.core.invoke(cmd, args) : mock[cmd](args);
  }
  function onProgress(fn) {
    if (IS_TAURI) TAURI.event.listen('showkit://progress', fn);
    else mockListeners.push(fn);
  }

  // ------------------------------------------------------------ definições
  const DEFAULTS = { lang: 'pt', theme: 'dark', checkOnStart: true, view: 'grid', sort: 'name' };
  let settings = { ...DEFAULTS };
  try { settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('showkit.settings') || '{}') }; } catch (_) { /* sem storage */ }
  function saveSettings() {
    try { localStorage.setItem('showkit.settings', JSON.stringify(settings)); } catch (_) { /* ignorar */ }
  }

  // ------------------------------------------------------------ estado
  const S = {
    catalog: null, offline: false, error: null, loading: true, checking: false, checkedAt: 0,
    releases: {}, relErr: {}, installed: {}, icons: {}, busy: {},
    info: { version: '0.0.0', windows: true }, launcherRel: null, selfUpdating: false
  };

  // ------------------------------------------------------------ utilitários
  function t(key, vars = {}) {
    const dict = window.I18N[settings.lang] || window.I18N.pt;
    let s = dict[key] ?? window.I18N.pt[key] ?? key;
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
    return s;
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function loc(o) {
    if (!o) return '';
    if (typeof o === 'string') return o;
    return o[settings.lang] || o.pt || o.en || '';
  }
  function cmpVer(a, b) {
    const pa = String(a || '').split(/[^0-9]+/).filter(Boolean).map(Number);
    const pb = String(b || '').split(/[^0-9]+/).filter(Boolean).map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return new Intl.DateTimeFormat(settings.lang === 'pt' ? 'pt-PT' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  }
  function fmtSize(b) {
    if (!b) return '—';
    const mb = b / 1048576;
    return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1).replace('.', settings.lang === 'pt' ? ',' : '.')} MB`;
  }
  function errMsg(e) {
    const s = String(e && e.message ? e.message : e);
    if (s === 'cancelled') return t('errCancelled');
    if (s.startsWith('exit:')) return t('errExit', { c: s.slice(5) });
    if (s.startsWith('net:') || s.startsWith('nocatalog')) return t('errNet');
    if (s === 'ratelimit') return t('errRate');
    if (s === 'incomplete') return t('errIncomplete');
    if (s === 'notfound') return t('errNotFound');
    if (s === 'nouninstall') return t('errNoUninstall');
    return t('errGeneric', { e: s });
  }
  function toast(msg, kind = 'ok') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4000);
  }
  // Apps do Daniel em "apps"; apps de outros autores dentro de cada grupo (groups[].apps).
  function apps() {
    if (!S.catalog) return [];
    const own = Array.isArray(S.catalog.apps) ? S.catalog.apps : [];
    const grouped = (Array.isArray(S.catalog.groups) ? S.catalog.groups : [])
      .flatMap((g) => (Array.isArray(g.apps) ? g.apps.map((a) => ({ ...a, group: g.id })) : []));
    return own.concat(grouped);
  }
  const appById = (id) => apps().find((a) => a.id === id);
  const anyBusy = () => Object.keys(S.busy).length > 0;
  function appState(a) {
    const inst = S.installed[a.id];
    const rel = S.releases[a.id];
    const canInstall = !!(rel && rel.asset_url);
    const hasUpdate = !!(inst && rel && canInstall && cmpVer(rel.version, inst.version) > 0);
    return { inst, rel, canInstall, hasUpdate, busy: S.busy[a.id] };
  }

  let rafPending = false;
  function renderSoon() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; render(); });
  }

  // ------------------------------------------------------------ i18n estático
  function applyI18n() {
    document.documentElement.lang = settings.lang;
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  }
  function applyTheme() {
    document.documentElement.dataset.theme = settings.theme;
  }

  // ------------------------------------------------------------ desenho
  function nameHtml(a) {
    return `<span class="app-name">${esc(a.name)}${a.nameAccent ? `<span class="accent">${esc(a.nameAccent)}</span>` : ''}</span>`;
  }
  function byLabel(a) {
    return a.publisher ? t('byX', { p: a.publisher.toUpperCase() }) : t('by');
  }
  function fullName(a) { return `${a.name || ''}${a.nameAccent || ''}`.trim(); }

  function versionHtml(a, st) {
    if (st.inst && st.hasUpdate) {
      return `<span class="ver update">V${esc(st.inst.version)}<span class="arrow">→</span>V${esc(st.rel.version)}</span>`;
    }
    if (st.inst) return `<span class="ver">V${esc(st.inst.version || '?')}</span>`;
    if (st.rel) return `<span class="ver">V${esc(st.rel.version)}</span>`;
    return `<span class="ver" style="color:var(--dim)">${S.relErr[a.id] ? '—' : '…'}</span>`;
  }

  function busyButton(b) {
    let label = t('working');
    let width = null;
    if (b.phase === 'download') {
      if (b.total > 0) {
        const pct = Math.min(100, Math.floor((b.received / b.total) * 100));
        label = t('downloading', { p: pct + '%' });
        width = pct;
      } else {
        label = t('downloading', { p: fmtSize(b.received) });
      }
    } else if (b.phase === 'install') label = t('installing');
    else if (b.phase === 'uninstall') label = t('uninstalling');
    const bar = width === null ? '<i class="bar indet"></i>' : `<i class="bar" style="width:${width}%"></i>`;
    return `<button class="btn main busy" disabled>${bar}<span>${esc(label)}</span></button>`;
  }

  function actionsHtml(a, st) {
    const lock = anyBusy();
    const more = `<button class="btn more" data-act="menu" data-id="${esc(a.id)}" title="…">…</button>`;
    if (st.busy) return busyButton(st.busy) + more;
    if (st.inst) {
      const open = `<button class="btn main" data-act="open" data-id="${esc(a.id)}">${t('open')}</button>`;
      const upd = st.hasUpdate
        ? `<button class="btn warn" style="padding:0 14px" data-act="update" data-id="${esc(a.id)}" ${lock ? 'disabled' : ''}>${t('update')}</button>`
        : '';
      return open + upd + more;
    }
    const dis = !st.canInstall || lock ? 'disabled' : '';
    return `<button class="btn main primary" data-act="install" data-id="${esc(a.id)}" ${dis}>${t('install')}</button>${more}`;
  }

  function statusLine(a, st) {
    if (st.inst) {
      const badge = st.hasUpdate ? `<span class="badge state-badge update">${t('updateAvailable')}</span>` : '';
      const d = st.rel ? `<div class="meta">${esc(t('lastUpdate', { d: fmtDate(st.rel.published_at) }))}</div>` : '';
      return badge + d;
    }
    if (!st.rel) {
      if (S.relErr[a.id]) return `<div class="meta">${esc(String(S.relErr[a.id]).startsWith('http:404') ? t('noRelease') : errMsg(S.relErr[a.id]))}</div>`;
      return `<div class="meta">${t('checking')}</div>`;
    }
    if (!st.canInstall) return `<div class="meta">${t('noAsset')}</div>`;
    return `<span class="badge state-badge">${t('available')}</span>
      <div class="meta">${esc(t('downloadSize', { s: fmtSize(st.rel.asset_size) }))}</div>`;
  }

  function iconHtml(a) {
    const src = S.icons[a.icon];
    return src ? `<img class="app-icon" src="${esc(src)}" alt="">` : '<div class="app-icon"></div>';
  }

  function cardHtml(a) {
    const st = appState(a);
    return `<article class="card" style="--accent:${esc(a.accent || '#3ddc84')}">
      <div class="card-top">${versionHtml(a, st)}
        <button class="gh-link" data-act="github" data-id="${esc(a.id)}">GITHUB ↗</button></div>
      <div class="card-body">
        <div class="head">${iconHtml(a)}
          <div><div class="app-name-row">${nameHtml(a)}<span class="badge">${esc(byLabel(a))}</span></div>
          <div class="category">${esc(loc(a.category))}</div></div>
        </div>
        <div class="tagline">${esc(loc(a.tagline))}</div>
        <div class="desc">${esc(loc(a.description))}</div>
        ${statusLine(a, st)}
      </div>
      <div class="actions">${actionsHtml(a, st)}</div>
    </article>`;
  }

  function rowHtml(a) {
    const st = appState(a);
    return `<div class="row" style="--accent:${esc(a.accent || '#3ddc84')}">
      ${iconHtml(a)}
      <div>${nameHtml(a)}<div class="category">${esc(loc(a.category))}</div></div>
      ${versionHtml(a, st)}
      <div class="tagline">${esc(loc(a.tagline))}</div>
      <div class="actions">${actionsHtml(a, st)}</div>
    </div>`;
  }

  function filtered() {
    const q = $('#search').value.trim().toLowerCase();
    let list = apps().filter((a) => {
      if (!q) return true;
      const hay = [fullName(a), a.id, ...['category', 'tagline', 'description'].flatMap((k) => Object.values(a[k] || {}))]
        .join(' ').toLowerCase();
      return hay.includes(q);
    });
    const byName = (x, y) => fullName(x).localeCompare(fullName(y), undefined, { sensitivity: 'base' });
    if (settings.sort === 'name-desc') list.sort((x, y) => byName(y, x));
    else if (settings.sort === 'updated') {
      const ts = (a) => Date.parse((S.releases[a.id] || {}).published_at || 0) || 0;
      list.sort((x, y) => ts(y) - ts(x));
    } else list.sort(byName);
    return list;
  }

  function render() {
    const c = $('#content');
    if (S.error) {
      c.innerHTML = `<div class="empty">${esc(t('loadError'))}<br><small>${esc(errMsg(S.error))}</small><br><br>
        <button class="btn" style="padding:0 18px" data-act="retry">${t('retry')}</button></div>`;
      renderStatus();
      return;
    }
    if (S.loading) {
      c.innerHTML = `<div class="grid">${'<div class="skeleton"></div>'.repeat(3)}</div>`;
      return;
    }
    const list = filtered();
    if (!list.length) {
      c.innerHTML = `<div class="empty">${t('noResults')}</div>`;
      renderStatus();
      return;
    }
    const block = (arr) => (settings.view === 'list'
      ? `<div class="list">${arr.map(rowHtml).join('')}</div>`
      : `<div class="grid">${arr.map(cardHtml).join('')}</div>`);
    const sections = (arr) => {
      const inst = arr.filter((a) => S.installed[a.id]);
      const rest = arr.filter((a) => !S.installed[a.id]);
      let h = '';
      if (inst.length) h += `<div class="section-title">${t('installed')}</div>${block(inst)}`;
      if (rest.length) h += `<div class="section-title">${t('notInstalled')}</div>${block(rest)}`;
      return h;
    };
    const groups = (S.catalog && Array.isArray(S.catalog.groups)) ? S.catalog.groups : [];
    const known = new Set(groups.map((g) => g.id));
    let html = sections(list.filter((a) => !a.group || !known.has(a.group)));
    for (const g of groups) {
      const arr = list.filter((a) => a.group === g.id);
      if (!arr.length) continue;
      html += `<div class="group-head"><div><div class="group-title">${esc(loc(g.title))}</div>
        ${g.note ? `<div class="group-note">${esc(loc(g.note))}</div>` : ''}</div>
        ${g.url ? `<button class="gh-link" data-act="group-url" data-url="${esc(g.url)}">${esc((g.url || '').replace(/^https:\/\//, '').toUpperCase())} ↗</button>` : ''}</div>`;
      html += `<div class="group-body">${sections(arr)}</div>`;
    }
    c.innerHTML = html;
    renderStatus();
  }

  function renderStatus() {
    const bar = $('.statusbar');
    bar.classList.toggle('offline', S.offline);
    let txt;
    if (S.offline) txt = t('offline');
    else if (S.checking || !S.checkedAt) txt = t('checking').toUpperCase();
    else {
      const mins = Math.floor((Date.now() - S.checkedAt) / 60000);
      const ago = mins < 1 ? t('justNow') : mins < 60 ? t('minAgo', { n: mins }) : t('hoursAgo', { n: Math.floor(mins / 60) });
      txt = t('checkedAgo', { t: ago });
    }
    if (!S.info.windows) txt += ' · ' + t('notWindows').toUpperCase();
    $('#status').textContent = txt;
  }

  function renderSelfBanner() {
    const el = $('#self-update');
    const r = S.launcherRel;
    if (S.selfUpdating) {
      el.innerHTML = `<span>${esc(t('selfUpdating'))}</span>`;
      el.classList.remove('hidden');
      return;
    }
    if (r && r.asset_url && cmpVer(r.version, S.info.version) > 0) {
      el.innerHTML = `<span>${esc(t('selfUpdate', { v: r.version }))}</span><div class="spacer"></div>
        <button class="btn" data-act="self-notes">${esc(t('menuNotes'))}</button>
        <button class="btn primary" data-act="self-update">${t('selfUpdateBtn')}</button>`;
      el.classList.remove('hidden');
    } else el.classList.add('hidden');
  }

  // ------------------------------------------------------------ dados
  async function refreshInstalled() {
    const specs = apps().map((a) => ({ id: a.id, detect: a.detect || {}, exe: a.exe || null, exeSearch: a.exeSearch || [] }));
    try { S.installed = await call('get_installed', { specs }); } catch (e) { toast(errMsg(e), 'error'); }
  }

  async function checkSelf(force) {
    const l = S.catalog && S.catalog.launcher;
    if (!l) return;
    try { S.launcherRel = await call('get_release', { repo: l.repo, asset: l.asset, force }); } catch (_) { /* sem release ainda */ }
    renderSelfBanner();
  }

  async function load(force) {
    if (S.checking) return;
    S.checking = true;
    $('#btn-refresh').classList.add('spin');
    try {
      const c = await call('get_catalog');
      S.catalog = c.catalog;
      S.offline = !!c.offline;
      S.error = null;
    } catch (e) {
      S.error = e;
      S.loading = false;
      S.checking = false;
      $('#btn-refresh').classList.remove('spin');
      render();
      return;
    }
    S.loading = false;
    render();
    rerenderDonate();

    apps().forEach((a) => {
      if (a.icon && !S.icons[a.icon]) {
        call('get_icon', { path: a.icon }).then((u) => { S.icons[a.icon] = u; renderSoon(); }).catch(() => {});
      }
    });
    const rel = apps().map((a) => call('get_release', { repo: a.repo, asset: a.asset, force })
      .then((r) => { S.releases[a.id] = r; delete S.relErr[a.id]; if (r.stale) S.offline = true; })
      .catch((e) => { S.relErr[a.id] = String(e); })
      .finally(renderSoon));
    await Promise.all([refreshInstalled(), ...rel, checkSelf(force)]);
    S.checking = false;
    S.checkedAt = Date.now();
    $('#btn-refresh').classList.remove('spin');
    render();
  }

  // ------------------------------------------------------------ ações
  async function doInstall(a, kind) {
    const st = appState(a);
    if (!st.rel || !st.rel.asset_url || anyBusy()) return;
    S.busy[a.id] = { phase: 'download', received: 0, total: st.rel.asset_size || 0 };
    render();
    try {
      await call('install_app', {
        id: a.id, url: st.rel.asset_url, fileName: st.rel.asset_name, size: st.rel.asset_size || 0, silentArgs: a.silentArgs || []
      });
      delete S.busy[a.id];
      await refreshInstalled();
      toast(kind === 'update' ? t('doneUpdate', { n: fullName(a), v: st.rel.version }) : t('doneInstall', { n: fullName(a) }));
    } catch (e) {
      delete S.busy[a.id];
      toast(errMsg(e), 'error');
    }
    render();
  }

  async function doUninstall(a) {
    const inst = S.installed[a.id];
    if (!inst || anyBusy()) return;
    S.busy[a.id] = { phase: 'uninstall', received: 0, total: 0 };
    render();
    try {
      await call('uninstall_app', { id: a.id, uninstall: inst.uninstall || null, quiet: inst.quiet || null, args: a.uninstallArgs || [] });
      delete S.busy[a.id];
      await refreshInstalled();
      toast(t('doneUninstall', { n: fullName(a) }));
    } catch (e) {
      delete S.busy[a.id];
      toast(errMsg(e), 'error');
    }
    render();
  }

  async function doOpen(a) {
    const inst = S.installed[a.id];
    if (!inst || !inst.exe) return toast(t('errNotFound'), 'error');
    try { await call('launch_app', { path: inst.exe }); } catch (e) { toast(errMsg(e), 'error'); }
  }

  function githubUrl(a) {
    return `https://github.com/${a.repo}/releases`;
  }

  async function doSelfUpdate() {
    const r = S.launcherRel;
    const l = S.catalog && S.catalog.launcher;
    if (!r || !r.asset_url || !l) return;
    S.selfUpdating = true;
    renderSelfBanner();
    try {
      await call('self_update', { url: r.asset_url, fileName: r.asset_name, size: r.asset_size || 0, silentArgs: l.silentArgs || ['/S'] });
    } catch (e) {
      S.selfUpdating = false;
      renderSelfBanner();
      toast(errMsg(e), 'error');
    }
  }

  // ------------------------------------------------------------ menu "..."
  function openMenu(btn, a) {
    const st = appState(a);
    const items = [];
    const lock = anyBusy();
    if (st.inst) {
      items.push(['open', t('menuOpen')]);
      if (st.hasUpdate && !lock) items.push(['update', t('menuUpdate')]);
      if (st.canInstall && !lock) items.push(['reinstall', t('menuReinstall')]);
    } else if (st.canInstall && !lock) items.push(['install', t('install').charAt(0) + t('install').slice(1).toLowerCase()]);
    if (st.rel) items.push(['notes', t('menuNotes')]);
    if (st.inst && st.inst.location) items.push(['folder', t('menuFolder')]);
    if (a.website) items.push(['website', t('menuWebsite')]);
    items.push(['github', t('menuGithub')]);
    if (st.inst && !lock) items.push(['-'], ['uninstall', t('menuUninstall'), 'danger']);

    const m = $('#menu');
    m.innerHTML = items.map(([act, label, cls]) => (act === '-' ? '<hr>'
      : `<button data-act="${act}" data-id="${esc(a.id)}" class="${cls || ''}">${esc(label)}</button>`)).join('');
    m.classList.remove('hidden');
    const r = btn.getBoundingClientRect();
    const mw = m.offsetWidth;
    const mh = m.offsetHeight;
    let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = r.top - mh - 4;
    m.style.left = Math.max(8, left) + 'px';
    m.style.top = Math.max(8, top) + 'px';
  }
  function closeMenu() { $('#menu').classList.add('hidden'); }

  // ------------------------------------------------------------ modais
  function modal(html) {
    $('#modal-box').innerHTML = html;
    $('#modal').classList.remove('hidden');
  }
  function closeModal() { $('#modal').classList.add('hidden'); }

  function showNotes(title, notes) {
    modal(`<div class="modal-head"><span>${esc(title)}</span></div>
      <div class="modal-body"><div class="notes">${esc(notes && notes.trim() ? notes.trim() : t('noNotes'))}</div></div>
      <div class="modal-foot"><button class="btn" data-act="close-modal">${esc(t('close').toUpperCase())}</button></div>`);
  }

  function confirmUninstall(a) {
    modal(`<div class="modal-head"><span>${esc(t('confirmUninstall', { n: fullName(a) }).toUpperCase())}</span></div>
      <div class="modal-body">${esc(t('confirmUninstallText'))}</div>
      <div class="modal-foot">
        <button class="btn" data-act="close-modal">${esc(t('cancel').toUpperCase())}</button>
        <button class="btn danger" data-act="confirm-uninstall" data-id="${esc(a.id)}">${esc(t('menuUninstall').toUpperCase())}</button>
      </div>`);
  }

  function showSettings() {
    const seg = (key, opts) => `<div class="seg">${opts.map(([v, label]) =>
      `<button class="${settings[key] === v ? 'active' : ''}" data-act="set" data-key="${key}" data-val="${v}">${esc(label)}</button>`).join('')}</div>`;
    modal(`<div class="modal-head"><span>${esc(t('settings').toUpperCase())}</span>
        <button class="gh-link" data-act="close-modal">✕</button></div>
      <div class="modal-body">
        <div class="setting"><span>${esc(t('sLanguage'))}</span>${seg('lang', [['pt', 'Português'], ['en', 'English']])}</div>
        <div class="setting"><span>${esc(t('sTheme'))}</span>${seg('theme', [['dark', t('sDark')], ['light', t('sLight')]])}</div>
        <div class="setting"><span>${esc(t('sCheckStart'))}</span>
          <button class="switch ${settings.checkOnStart ? 'on' : ''}" data-act="toggle-check"></button></div>
        <div class="sub-title">${esc(t('sAbout').toUpperCase())}</div>
        <div class="about" style="margin-top:0;border-top:0;padding-top:4px">
          <img src="logo-big.png" alt="">
          <div><b>ShowKit</b> <span style="color:var(--dim)">${esc(t('sVersion', { v: S.info.version }))}</span>
            <p>${esc(t('sAboutText'))}</p>
            <p>${esc(t('sMadeBy'))} · <button class="link" data-act="author">github.com/NunesDanielPT</button></p>
          </div>
        </div>
      </div>
      <div class="modal-foot"><button class="btn" data-act="check-self">${esc(t('sCheckSelf').toUpperCase())}</button></div>`);
  }

  // ------------------------------------------------------------ eventos
  document.addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!$('#menu').contains(ev.target) && !(el && el.dataset.act === 'menu')) closeMenu();
    if (ev.target.id === 'modal') return closeModal();
    if (!el || el.disabled) return;
    const a = el.dataset.id ? appById(el.dataset.id) : null;
    const act = el.dataset.act;
    if (el.closest('#menu')) closeMenu();

    switch (act) {
      case 'menu': return openMenu(el, a);
      case 'open': return doOpen(a);
      case 'install': return doInstall(a, 'install');
      case 'reinstall': return doInstall(a, 'install');
      case 'update': return doInstall(a, 'update');
      case 'uninstall': return confirmUninstall(a);
      case 'confirm-uninstall': closeModal(); return doUninstall(a);
      case 'notes': {
        const r = S.releases[a.id];
        return showNotes(t('notesTitle', { n: fullName(a), v: r ? r.version : '' }), r && r.notes);
      }
      case 'folder': return call('open_folder', { path: S.installed[a.id].location }).catch((e) => toast(errMsg(e), 'error'));
      case 'github': return call('open_url', { url: githubUrl(a) }).catch(() => {});
      case 'group-url': return call('open_url', { url: el.dataset.url }).catch(() => {});
      case 'website': return call('open_url', { url: a.website }).catch(() => {});
      case 'author': return call('open_url', { url: 'https://github.com/NunesDanielPT' }).catch(() => {});
      case 'retry': S.loading = true; render(); return load(true);
      case 'close-modal': return closeModal();
      case 'self-update': return doSelfUpdate();
      case 'self-notes': return showNotes(t('notesTitle', { n: 'ShowKit', v: S.launcherRel.version }), S.launcherRel.notes);
      case 'set':
        settings[el.dataset.key] = el.dataset.val;
        saveSettings(); applyTheme(); applyI18n(); render(); renderSelfBanner(); rerenderDonate();
        return showSettings();
      case 'toggle-check':
        settings.checkOnStart = !settings.checkOnStart;
        saveSettings();
        return el.classList.toggle('on', settings.checkOnStart);
      case 'check-self': {
        await checkSelf(true);
        const r = S.launcherRel;
        if (!r || cmpVer(r.version, S.info.version) <= 0) toast(t('sSelfLatest'), 'info');
        return;
      }
      default:
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { closeMenu(); closeModal(); }
    if (ev.key === 'F5') { ev.preventDefault(); load(true); }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f') { ev.preventDefault(); $('#search').focus(); }
  });
  $('main').addEventListener('scroll', closeMenu);
  window.addEventListener('resize', closeMenu);
  // Sem menu de contexto do browser dentro da app.
  document.addEventListener('contextmenu', (ev) => { if (IS_TAURI && ev.target.tagName !== 'INPUT') ev.preventDefault(); });

  $('#search').addEventListener('input', render);
  $('#sort').addEventListener('change', (e) => { settings.sort = e.target.value; saveSettings(); render(); });
  $('#view-grid').addEventListener('click', () => setView('grid'));
  $('#view-list').addEventListener('click', () => setView('list'));
  $('#btn-refresh').addEventListener('click', () => load(true));
  $('#btn-settings').addEventListener('click', showSettings);
  $('#foot-github').addEventListener('click', () => call('open_url', { url: 'https://github.com/NunesDanielPT' }).catch(() => {}));

  function setView(v) {
    settings.view = v;
    saveSettings();
    $('#view-grid').classList.toggle('active', v === 'grid');
    $('#view-list').classList.toggle('active', v === 'list');
    render();
  }

  if (IS_TAURI) {
    const win = TAURI.window.getCurrentWindow();
    $('#btn-min').addEventListener('click', () => win.minimize());
    $('#btn-max').addEventListener('click', () => win.toggleMaximize());
    $('#btn-close').addEventListener('click', () => win.close());
  } else {
    document.querySelectorAll('.tb-btn.win').forEach((b) => b.classList.add('hidden'));
  }

  onProgress((ev) => {
    const p = ev.payload;
    if (!p || !p.id) return;
    if (p.id === 'showkit') return;
    if (p.phase === 'done') return;
    if (S.busy[p.id]) {
      S.busy[p.id] = p;
      renderSoon();
    }
  });

  setInterval(renderStatus, 30000);

  // ------------------------------------------------------------ separadores (Aplicações / Doações)
  let tab = 'apps';
  function setTab(name) {
    tab = name;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $('#apps-view').classList.toggle('hidden', name !== 'apps');
    $('#donate-view').classList.toggle('hidden', name !== 'donate');
    if (name === 'donate' && window.ShowKitDonate) window.ShowKitDonate.render();
    closeMenu();
    $('main').scrollTop = 0;
  }
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  const rerenderDonate = () => { if (tab === 'donate' && window.ShowKitDonate) window.ShowKitDonate.render(); };

  // Ponte para o donate.js
  window.ShowKit = {
    t,
    lang: () => settings.lang,
    catalog: () => S.catalog,
    apps,
    fullName,
    version: () => S.info.version,
    openUrl: (url) => call('open_url', { url }).catch((e) => toast(errMsg(e), 'error'))
  };

  // ------------------------------------------------------------ arranque
  (async () => {
    applyTheme();
    applyI18n();
    $('#sort').value = settings.sort;
    setView(settings.view);
    try { S.info = await call('app_info'); } catch (_) { /* fica o valor por omissão */ }
    await load(settings.checkOnStart);
  })();
})();

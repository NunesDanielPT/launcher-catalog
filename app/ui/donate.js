// ShowKit — separador "Doações".
// As doações ficam preparadas mas desligadas até existir um sistema de pagamento.
// Para as ligar sem lançar versão nova, no apps.json:
//   "donations": { "enabled": true, "url": "https://…?amount={amount}&currency=EUR&freq={frequency}&method={method}" }
// ({amount}, {frequency}, {method}, {name} e {message} são substituídos pelo que a pessoa escolheu.)
(() => {
  'use strict';

  const AMOUNTS = [5, 10, 20, 50];
  const METHODS = ['mbway', 'paypal', 'card', 'transfer'];
  const ISSUES = 'https://github.com/NunesDanielPT/launcher-catalog/issues/new';

  const D = { amount: 10, custom: '', frequency: 'once', method: 'mbway', name: '', message: '', publicName: true };

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function api() { return window.ShowKit; }
  function t(k, v) { return api().t(k, v); }
  function config() {
    const c = api().catalog();
    return (c && c.donations) || { enabled: false };
  }
  function amount() {
    if (D.amount === 'custom') {
      const n = parseFloat(String(D.custom).replace(',', '.'));
      return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
    }
    return D.amount;
  }
  function money(n) {
    return new Intl.NumberFormat(api().lang() === 'pt' ? 'pt-PT' : 'en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
  }

  function pills(group, items, current) {
    return items.map(([val, label]) =>
      `<button class="pill ${String(current) === String(val) ? 'active' : ''}" data-dset="${group}" data-val="${esc(val)}">${label}</button>`).join('');
  }

  function render() {
    const view = $('#donate-view');
    const cfg = config();
    const enabled = !!(cfg.enabled && cfg.url);
    const a = amount();
    const apps = api().apps();
    const appOptions = [`<option value="">${esc(t('dGeneral'))}</option>`]
      .concat(apps.filter((x) => !x.group).map((x) => `<option value="${esc(api().fullName(x))}">${esc(api().fullName(x))}</option>`)).join('');

    view.innerHTML = `
      <div class="donate">
        <div class="donate-hero">
          <div class="hero-mark">♥</div>
          <div>
            <h1>${esc(t('dTitle'))}</h1>
            <p class="lead">${esc(t('dLead'))}</p>
            <p class="muted">${esc(t('dLead2'))}</p>
          </div>
        </div>

        <div class="ways">
          <div class="way"><b>${esc(t('dWay1'))}</b><span>${esc(t('dWay1Text'))}</span></div>
          <div class="way"><b>${esc(t('dWay2'))}</b><span>${esc(t('dWay2Text'))}</span></div>
          <div class="way"><b>${esc(t('dWay3'))}</b><span>${esc(t('dWay3Text'))}</span></div>
        </div>

        <div class="donate-cols">
          <div class="panel">
            <div class="panel-head">${esc(t('dDonateHead'))}</div>
            <div class="panel-body">
              <div class="field-label">${esc(t('dAmount'))}</div>
              <div class="pills">
                ${pills('amount', AMOUNTS.map((n) => [n, money(n)]).concat([['custom', esc(t('dOther'))]]), D.amount)}
              </div>
              ${D.amount === 'custom' ? `<div class="custom-amount"><input id="d-custom" type="text" inputmode="decimal" placeholder="0,00" value="${esc(D.custom)}"><span>€</span></div>` : ''}

              <div class="field-label">${esc(t('dFrequency'))}</div>
              <div class="pills">${pills('frequency', [['once', esc(t('dOnce'))], ['monthly', esc(t('dMonthly'))]], D.frequency)}</div>

              <div class="field-label">${esc(t('dMethod'))}</div>
              <div class="pills">${pills('method', METHODS.map((m) => [m, esc(t('dM_' + m))]), D.method)}</div>

              <div class="field-label">${esc(t('dName'))}</div>
              <input id="d-name" type="text" maxlength="60" value="${esc(D.name)}" placeholder="${esc(t('dNamePh'))}">
              <div class="field-label">${esc(t('dMessage'))}</div>
              <textarea id="d-message" rows="3" maxlength="500" placeholder="${esc(t('dMessagePh'))}">${esc(D.message)}</textarea>
              <label class="check"><input id="d-public" type="checkbox" ${D.publicName ? 'checked' : ''}> ${esc(t('dPublic'))}</label>

              <div class="summary">${a > 0
                ? esc(t(D.frequency === 'monthly' ? 'dSummaryMonthly' : 'dSummaryOnce', { a: money(a), m: t('dM_' + D.method) }))
                : esc(t('dSummaryNone'))}</div>
            </div>
            <div class="panel-foot">
              <button class="btn primary donate-btn" data-act-d="donate" ${enabled && a > 0 ? '' : 'disabled'}>
                ${esc(a > 0 ? t('dDonateBtn', { a: money(a) }) : t('dDonateBtnEmpty'))}
              </button>
              ${enabled ? '' : `<div class="unavailable"><span class="dot"></span>${esc(t('dUnavailable'))}</div>
                <div class="unavailable-sub">${esc(t('dUnavailableSub'))}</div>`}
            </div>
          </div>

          <div class="panel">
            <div class="panel-head">${esc(t('dFeedbackHead'))}</div>
            <div class="panel-body">
              <p class="muted" style="margin-top:0">${esc(t('dFeedbackText'))}</p>
              <div class="field-label">${esc(t('dAbout'))}</div>
              <div class="select-wrap"><select id="d-app" style="width:100%">${appOptions}</select></div>
              <div class="fb-buttons">
                <button class="btn" data-act-d="idea">${esc(t('dIdea'))}</button>
                <button class="btn" data-act-d="bug">${esc(t('dBug'))}</button>
                <button class="btn" data-act-d="opinion">${esc(t('dOpinion'))}</button>
              </div>
              <p class="tiny">${esc(t('dGithubNote'))}</p>
            </div>
            <div class="panel-head" style="border-top:1px solid var(--line)">${esc(t('dOpenHead'))}</div>
            <div class="panel-body">
              <p class="muted" style="margin-top:0">${esc(t('dOpenText'))}</p>
              <button class="btn" data-act-d="source">GITHUB.COM/NUNESDANIELPT ↗</button>
            </div>
          </div>
        </div>
        <p class="thanks">${esc(t('dThanks'))}</p>
      </div>`;
  }

  function openIssue(kind) {
    const app = $('#d-app') ? $('#d-app').value : '';
    const prefix = { idea: t('dIssueIdea'), bug: t('dIssueBug'), opinion: t('dIssueOpinion') }[kind];
    const title = `[${prefix}]${app ? ' ' + app + ' —' : ''} `;
    const body = kind === 'bug' ? t('dBugTemplate', { v: api().version() }) : '';
    const url = `${ISSUES}?title=${encodeURIComponent(title)}${body ? '&body=' + encodeURIComponent(body) : ''}`;
    api().openUrl(url);
  }

  function donate() {
    const cfg = config();
    const a = amount();
    if (!cfg.enabled || !cfg.url || a <= 0) return;
    const url = cfg.url
      .replaceAll('{amount}', encodeURIComponent(a))
      .replaceAll('{frequency}', encodeURIComponent(D.frequency))
      .replaceAll('{method}', encodeURIComponent(D.method))
      .replaceAll('{name}', encodeURIComponent(D.publicName ? D.name : ''))
      .replaceAll('{message}', encodeURIComponent(D.message));
    api().openUrl(url);
  }

  document.addEventListener('click', (ev) => {
    const set = ev.target.closest('[data-dset]');
    if (set) {
      const k = set.dataset.dset;
      const v = set.dataset.val;
      D[k] = k === 'amount' && v !== 'custom' ? Number(v) : v;
      render();
      if (k === 'amount' && v === 'custom') $('#d-custom').focus();
      return;
    }
    const act = ev.target.closest('[data-act-d]');
    if (!act || act.disabled) return;
    const a = act.dataset.actD;
    if (a === 'donate') donate();
    else if (a === 'source') api().openUrl('https://github.com/NunesDanielPT');
    else openIssue(a);
  });

  document.addEventListener('input', (ev) => {
    const id = ev.target.id;
    if (id === 'd-custom') {
      D.custom = ev.target.value.replace(/[^0-9.,]/g, '');
      const pos = ev.target.selectionStart;
      render();
      const el = $('#d-custom');
      el.focus();
      el.setSelectionRange(pos, pos);
    } else if (id === 'd-name') D.name = ev.target.value;
    else if (id === 'd-message') D.message = ev.target.value;
  });
  document.addEventListener('change', (ev) => {
    if (ev.target.id === 'd-public') D.publicName = ev.target.checked;
  });

  window.ShowKitDonate = { render };
})();

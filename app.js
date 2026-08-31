/* MYBILL — Application shell & UI
 * Vanilla JS, hash-routed, single global Store (see store.js).
 */
(function () {
  const S = window.MyBillStore;
  const H = window.MyBillHelpers;
  const root = document.getElementById('app');
  const fmt = (n) => {
    const sym = S.state.profile.currencySymbol || '₹';
    const num = Math.round((Number(n) || 0) * 100) / 100;
    return `${sym}${num.toLocaleString('en-IN')}`;
  };
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ROUTES = ['dashboard', 'transactions', 'people', 'budgets', 'goals', 'bills', 'analytics', 'accounts', 'settings', 'help'];
  const NAV_ICONS = {
    dashboard: '🏠', transactions: '📄', people: '👥', budgets: '🥧',
    goals: '🎯', bills: '🔔', analytics: '📊', accounts: '💳',
    settings: '⚙️', help: '❓'
  };

  let undoStack = null; // {tx, timeout}
  let charts = {}; // keep references so we can destroy before re-render

  /* ---------------- Init ---------------- */
  function init() {
    applyTheme();
    if (!S.state.profile.onboarded) {
      renderOnboarding();
    } else {
      renderShell();
      window.addEventListener('hashchange', router);
      router();
    }
    S.onChange(() => { if (S.state.profile.onboarded) router(); });
    window.addEventListener('online', updateNetStatus);
    window.addEventListener('offline', updateNetStatus);
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', S.state.profile.theme || 'light');
  }

  /* ---------------- Onboarding ---------------- */
  function renderOnboarding() {
    const driveConfigured = window.MyBillDrive && window.MyBillDrive.isConfigured();
    root.innerHTML = `
    <div class="onboard-screen">
      <div class="onboard-card">
        <div class="brand"><span class="brand-mark">M</span>MYBILL</div>
        <p class="tagline">Your Personal Finance OS</p>
        ${driveConfigured ? `
        <div class="restore-box">
          <p class="muted small">Already using MYBILL on another device?</p>
          <button type="button" id="restore-drive-btn" class="btn-ghost btn-block">Restore from Google Drive</button>
          <p class="muted small" id="restore-status"></p>
        </div>
        <div class="divider"><span>or start fresh</span></div>` : ''}
        <form id="onboard-form" class="onboard-form">
          <label>Your name<input name="name" required placeholder="e.g. Aditi"></label>
          <label>Currency
            <select name="currency">
              <option value="INR" selected>₹ Indian Rupee</option>
              <option value="USD">$ US Dollar</option>
              <option value="EUR">€ Euro</option>
            </select>
          </label>
          <label>Monthly pocket money / income<input name="pocket" type="number" min="0" placeholder="12000"></label>
          <label>Cash on hand<input name="cash" type="number" min="0" placeholder="500"></label>
          <label>Main bank account name<input name="bank" placeholder="e.g. SBI"></label>
          <label>Bank balance<input name="bankBal" type="number" min="0" placeholder="4500"></label>
          <label>Monthly savings target (optional)<input name="savings" type="number" min="0" placeholder="1000"></label>
          <label class="checkbox-row"><input type="checkbox" name="isStudent" checked> I'm a student / hosteller</label>
          <button type="submit" class="btn-primary btn-block">Get started</button>
          <button type="button" id="skip-onboard" class="btn-ghost btn-block">Skip for now</button>
        </form>
      </div>
    </div>`;
    document.getElementById('onboard-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      finishOnboarding(f);
    });
    document.getElementById('skip-onboard').addEventListener('click', () => finishOnboarding(new FormData()));
    if (driveConfigured) {
      document.getElementById('restore-drive-btn').addEventListener('click', async () => {
        const statusEl = document.getElementById('restore-status');
        const btn = document.getElementById('restore-drive-btn');
        btn.disabled = true; btn.textContent = 'Connecting…';
        statusEl.textContent = '';
        try {
          if (!window.MyBillDrive.isConnected()) await window.MyBillDrive.connect();
          statusEl.textContent = 'Looking for your data…';
          const found = await window.MyBillDrive.restoreFromDrive();
          if (found) {
            statusEl.textContent = 'Data restored — loading your MYBILL…';
            renderShell();
            window.addEventListener('hashchange', router);
            location.hash = '#dashboard';
            router();
          } else {
            statusEl.textContent = 'No existing MYBILL data found in this Google account\'s Drive. You can start fresh below.';
            btn.disabled = false; btn.textContent = 'Restore from Google Drive';
          }
        } catch (err) {
          statusEl.textContent = 'Could not connect: ' + (err && err.message ? err.message : 'unknown error');
          btn.disabled = false; btn.textContent = 'Restore from Google Drive';
        }
      });
    }
  }

  function finishOnboarding(f) {
    const currencyMap = { INR: '₹', USD: '$', EUR: '€' };
    const currency = f.get('currency') || 'INR';
    S.state.profile = Object.assign(S.state.profile, {
      onboarded: true,
      name: f.get('name') || 'Friend',
      currency, currencySymbol: currencyMap[currency] || '₹',
      isStudent: !!f.get('isStudent'),
      savingsMonthlyTarget: Number(f.get('savings')) || 0
    });
    const cash = Number(f.get('cash')) || 0;
    S.addAccount({ name: 'Cash', type: 'Cash', openingBalance: cash });
    const bankName = f.get('bank');
    const bankBal = Number(f.get('bankBal')) || 0;
    if (bankName) S.addAccount({ name: bankName, type: 'Bank', openingBalance: bankBal });
    const pocket = Number(f.get('pocket'));
    if (pocket) {
      const acc = S.state.accounts[S.state.accounts.length - 1] || S.state.accounts[0];
      S.addTransaction({ type: 'income', amount: pocket, category: 'Home/Pocket Money', accountId: acc.id, note: 'Initial pocket money' });
    }
    S.save();
    renderShell();
    window.addEventListener('hashchange', router);
    location.hash = '#dashboard';
    router();
  }

  /* ---------------- Shell (nav chrome) ---------------- */
  function renderShell() {
    root.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark">M</span>MYBILL</div>
        <nav class="side-nav">
          ${ROUTES.map(r => `<a href="#${r}" data-route="${r}" class="side-link"><span>${NAV_ICONS[r]}</span><span>${label(r)}</span></a>`).join('')}
        </nav>
        <div class="sync-pill" id="sync-pill">●&nbsp;Local only</div>
      </aside>
      <div class="sidebar-overlay only-mobile"></div>
      <div class="main-col">
        <header class="topbar">
          <button id="hamburger" class="icon-btn only-mobile" aria-label="Menu">☰</button>
          <div class="search-wrap">
            <input id="global-search" placeholder="Search transactions, people, categories…">
            <div id="search-results" class="search-results hidden"></div>
          </div>
          <button id="theme-toggle" class="icon-btn" title="Toggle dark mode">◐</button>
        </header>
        <main id="page" class="page"></main>
      </div>
      <nav class="bottom-nav only-mobile">
        <a href="#dashboard" data-route="dashboard">🏠<span>Home</span></a>
        <a href="#transactions" data-route="transactions">📄<span>Txns</span></a>
        <a href="#" id="quick-add-btn" class="fab-nav">＋<span>Add</span></a>
        <a href="#people" data-route="people">👥<span>People</span></a>
        <a href="#settings" data-route="settings">⋯<span>More</span></a>
      </nav>
    </div>
    <div id="modal-root"></div>
    <div id="toast-root"></div>`;

    document.getElementById('theme-toggle').addEventListener('click', () => {
      S.state.profile.theme = S.state.profile.theme === 'dark' ? 'light' : 'dark';
      S.save(); applyTheme();
    });
    document.getElementById('quick-add-btn').addEventListener('click', (e) => { e.preventDefault(); openQuickAddSheet(); });
    document.getElementById('global-search').addEventListener('input', onSearchInput);
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    const closeSidebar = () => sidebar.classList.remove('open');
    document.getElementById('hamburger').addEventListener('click', () => sidebar.classList.toggle('open'));
    overlay.addEventListener('click', closeSidebar);
    sidebar.querySelectorAll('.side-link').forEach(link => link.addEventListener('click', closeSidebar));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });
    updateNetStatus();
  }

  function label(r) { return r.charAt(0).toUpperCase() + r.slice(1); }

  function updateNetStatus() {
    const pill = document.getElementById('sync-pill');
    if (!pill) return;
    if (!navigator.onLine) { pill.textContent = '● Offline — saved locally'; pill.className = 'sync-pill warn'; return; }
    if (window.MyBillDrive && window.MyBillDrive.isConnected()) { pill.textContent = '● Synced to Drive'; pill.className = 'sync-pill ok'; }
    else { pill.textContent = '● Local only'; pill.className = 'sync-pill'; }
  }
  if (window.MyBillDrive) window.MyBillDrive.onStatus((status) => {
    const pill = document.getElementById('sync-pill');
    if (!pill) return;
    const map = { syncing: ['● Syncing…', ''], synced: ['● Synced to Drive', 'ok'], 'sync failed': ['● Sync failed — retrying', 'warn'], offline: ['● Local only', ''] };
    const [text, cls] = map[status] || ['● Local only', ''];
    pill.textContent = text; pill.className = `sync-pill ${cls}`;
  });

  /* ---------------- Router ---------------- */
  function router() {
    const raw = (location.hash || '#dashboard').replace('#', '');

    // Sub-route: #budget/<envelopeId> — full Budget Details screen
    if (raw.startsWith('budget/')) {
      const envId = raw.slice('budget/'.length);
      const env = S.state.envelopes.find(e => e.id === envId);
      document.querySelectorAll('[data-route]').forEach(a => a.classList.toggle('active', a.dataset.route === 'budgets'));
      const page = document.getElementById('page');
      if (!page) return;
      Object.values(charts).forEach(c => c && c.destroy && c.destroy());
      charts = {};
      if (!env) { location.hash = '#budgets'; return; }
      renderBudgetDetails(page, env.id);
      return;
    }

    const route = ROUTES.includes(raw) ? raw : 'dashboard';
    document.querySelectorAll('[data-route]').forEach(a => a.classList.toggle('active', a.dataset.route === route));
    const page = document.getElementById('page');
    if (!page) return;
    Object.values(charts).forEach(c => c && c.destroy && c.destroy());
    charts = {};
    const renderers = {
      dashboard: renderDashboard, transactions: renderTransactions, people: renderPeople,
      budgets: renderBudgets, goals: renderGoals, bills: renderBills, analytics: renderAnalytics,
      accounts: renderAccounts, settings: renderSettings, help: renderHelp
    };
    renderers[route](page);
  }

  /* ---------------- Toast / undo ---------------- */
  function toast(msg, actionLabel, actionFn) {
    const r = document.getElementById('toast-root');
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span>${escapeHtml(msg)}</span>${actionLabel ? `<button class="toast-action">${actionLabel}</button>` : ''}`;
    r.appendChild(el);
    if (actionLabel) el.querySelector('.toast-action').addEventListener('click', () => { actionFn(); el.remove(); });
    setTimeout(() => el.remove(), 6000);
  }

  /* ---------------- Empty state helper ---------------- */
  function emptyState(msg, cta, onClick) {
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.innerHTML = `<p>${escapeHtml(msg)}</p>${cta ? `<button class="btn-primary">${escapeHtml(cta)}</button>` : ''}`;
    if (cta) div.querySelector('button').addEventListener('click', onClick);
    return div.outerHTML;
  }

  /* ================= DASHBOARD ================= */
  function renderDashboard(page) {
    const p = S.state.profile;
    const balances = S.balancesByType();
    const total = S.totalBalance();
    const sts = S.safeToSpend();
    const income = S.monthIncome(), expense = S.monthExpense();
    const savingsRate = income > 0 ? Math.round(((income - expense) / income) * 100) : 0;
    const recent = [...S.state.transactions].sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)).slice(0, 8);
    const upcoming = S.upcomingRecurring(14);
    const overdue = S.overdueRecurring();

    page.innerHTML = `
    <div class="page-head">
      <div><h1>Hi ${escapeHtml(p.name || 'there')} 👋</h1><p class="muted">Here's where things stand today.</p></div>
      <button class="btn-primary" id="dash-add">+ Add transaction</button>
    </div>

    <section class="kpi-grid">
      <div class="kpi kpi-primary"><span class="kpi-label">Total balance</span><span class="kpi-value">${fmt(total)}</span></div>
      ${Object.entries(balances).map(([k, v]) => `<div class="kpi"><span class="kpi-label">${escapeHtml(k)}</span><span class="kpi-value">${fmt(v)}</span></div>`).join('')}
      <div class="kpi"><span class="kpi-label">Receivable</span><span class="kpi-value pos">${fmt(sts.receivable)}</span></div>
      <div class="kpi"><span class="kpi-label">Payable</span><span class="kpi-value neg">${fmt(sts.payable)}</span></div>
    </section>

    <section class="card safe-spend-card">
      <div>
        <span class="muted">Safe to spend per day</span>
        <div class="big-number">${fmt(sts.perDay)}<span class="muted small">/day · ${sts.days} days left</span></div>
      </div>
      <div class="muted small">balance ${fmt(sts.balance)} + receivable ${fmt(sts.receivable)} − payable ${fmt(sts.payable)} − upcoming ${fmt(sts.upcoming)} − savings goal ${fmt(sts.savingsTarget)}</div>
    </section>

    <section class="grid-2">
      <div class="card">
        <h3>This month</h3>
        <div class="row-stats">
          <div><span class="muted">Income</span><div class="stat pos">${fmt(income)}</div></div>
          <div><span class="muted">Expense</span><div class="stat neg">${fmt(expense)}</div></div>
          <div><span class="muted">Savings rate</span><div class="stat">${savingsRate}%</div></div>
        </div>
        <canvas id="chart-monthly"></canvas>
      </div>
      <div class="card">
        <h3>Spending by category</h3>
        <canvas id="chart-category"></canvas>
      </div>
    </section>

    <section class="card">
      <h3>Last 14 days</h3>
      <canvas id="chart-daily"></canvas>
    </section>

    <section class="grid-2">
      <div class="card">
        <div class="card-head"><h3>Recent transactions</h3><a href="#transactions">See all</a></div>
        ${recent.length ? `<ul class="tx-list">${recent.map(txRow).join('')}</ul>` : emptyState('No transactions yet.', '+ Add expense', openQuickAddSheet)}
      </div>
      <div class="card">
        <div class="card-head"><h3>Upcoming &amp; overdue</h3><a href="#bills">Manage</a></div>
        ${overdue.length ? `<p class="alert-line">⚠ ${overdue.length} overdue payment${overdue.length > 1 ? 's' : ''}</p>` : ''}
        ${upcoming.length ? `<ul class="simple-list">${upcoming.slice(0, 6).map(r => `<li><span>${escapeHtml(r.name)}</span><span class="muted">${r.nextDate}</span><span>${fmt(r.amount)}</span></li>`).join('')}</ul>` : emptyState('Nothing due soon.', null)}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Budgets</h3><a href="#budgets">Manage</a></div>
      ${S.state.envelopes.length
        ? `<ul class="simple-list">${S.allEnvelopeStats().slice(0, 6).map(st => `<li><span>${escapeHtml(st.envelope.name)}</span><span class="${st.balance < 0 ? 'neg' : ''}">${fmt(st.balance)} remaining</span></li>`).join('')}</ul>`
        : emptyState('No budgets created yet.', '+ Create Your First Budget', () => { location.hash = '#budgets'; })}
    </section>`;

    document.getElementById('dash-add').addEventListener('click', openQuickAddSheet);
    bindTxRowActions(page);

    const trend = S.monthlyTrend(6);
    charts.monthly = new Chart(document.getElementById('chart-monthly'), {
      type: 'bar',
      data: { labels: trend.map(t => t.month.slice(5)), datasets: [
        { label: 'Income', data: trend.map(t => t.income), backgroundColor: '#2e7d5b' },
        { label: 'Expense', data: trend.map(t => t.expense), backgroundColor: '#c0533e' }
      ] },
      options: chartOpts()
    });
    const cat = S.categoryBreakdown();
    charts.category = new Chart(document.getElementById('chart-category'), {
      type: 'doughnut',
      data: { labels: Object.keys(cat), datasets: [{ data: Object.values(cat), backgroundColor: palette(Object.keys(cat).length) }] },
      options: { plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } } } }
    });
    const daily = S.dailySpendSeries(14);
    charts.daily = new Chart(document.getElementById('chart-daily'), {
      type: 'line',
      data: { labels: daily.map(d => d.date.slice(5)), datasets: [{ label: 'Spend', data: daily.map(d => d.total), borderColor: '#3a6ea5', tension: 0.3, fill: true, backgroundColor: 'rgba(58,110,165,0.08)' }] },
      options: chartOpts()
    });
  }

  function chartOpts() { return { plugins: { legend: { display: true, labels: { boxWidth: 10 } } }, scales: { y: { beginAtZero: true } } }; }
  function palette(n) {
    const base = ['#3a6ea5', '#c0533e', '#2e7d5b', '#a6842f', '#7a5ea8', '#4d9aa8', '#b25a8f', '#6b6b6b'];
    return Array.from({ length: n }, (_, i) => base[i % base.length]);
  }

  function txRow(t) {
    const acc = S.state.accounts.find(a => a.id === t.accountId);
    const person = S.state.people.find(p => p.id === t.personId);
    const env = t.envelopeId ? S.state.envelopes.find(e => e.id === t.envelopeId) : null;
    const sign = ['income', 'refund', 'repay_received', 'borrow'].includes(t.type) ? '+' : (t.type === 'transfer' ? '↔' : '−');
    const cls = sign === '+' ? 'pos' : (sign === '↔' ? '' : 'neg');
    return `<li class="tx-row" data-id="${t.id}">
      <div class="tx-main">
        <span class="tx-cat">${escapeHtml(t.merchant || t.category || t.type)}</span>
        <span class="muted small">${t.date} · ${acc ? escapeHtml(acc.name) : ''}${person ? ' · ' + escapeHtml(person.name) : ''}${env ? ` · <a href="#budget/${env.id}">${escapeHtml(env.name)}</a>` : ''}</span>
      </div>
      <span class="tx-amount ${cls}">${sign}${fmt(t.amount)}</span>
      <button class="icon-btn tx-edit" title="Edit">✎</button>
      <button class="icon-btn tx-delete" title="Delete">🗑</button>
    </li>`;
  }
  function bindTxRowActions(scope) {
    scope.querySelectorAll('.tx-edit').forEach(b => b.addEventListener('click', (e) => {
      const id = e.target.closest('.tx-row').dataset.id;
      openTransactionModal(S.state.transactions.find(t => t.id === id));
    }));
    scope.querySelectorAll('.tx-delete').forEach(b => b.addEventListener('click', (e) => {
      const id = e.target.closest('.tx-row').dataset.id;
      const removed = S.deleteTransaction(id);
      toast('Transaction deleted', 'UNDO', () => S.restoreTransaction(removed));
    }));
  }

  /* ================= TRANSACTIONS ================= */
  function renderTransactions(page) {
    const cats = Object.keys(S.state.categories);
    page.innerHTML = `
    <div class="page-head"><h1>Transactions</h1><button class="btn-primary" id="tx-add">+ Add</button></div>
    <div class="filter-bar">
      <input type="date" id="f-from"><input type="date" id="f-to">
      <select id="f-type"><option value="">All types</option>${['income', 'expense', 'transfer', 'lend', 'borrow', 'repay_received', 'repay_paid', 'refund', 'bill', 'subscription'].map(t => `<option value="${t}">${t}</option>`).join('')}</select>
      <select id="f-category"><option value="">All categories</option>${cats.map(c => `<option value="${c}">${c}</option>`).join('')}</select>
      <select id="f-account"><option value="">All accounts</option>${S.state.accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}</select>
    </div>
    <div class="card"><ul class="tx-list" id="tx-full-list"></ul></div>`;
    document.getElementById('tx-add').addEventListener('click', () => openTransactionModal());
    const rerender = () => {
      const filters = {
        dateFrom: val('f-from'), dateTo: val('f-to'), type: val('f-type'),
        category: val('f-category'), accountId: val('f-account')
      };
      const list = S.filterTransactions(filters);
      const ul = document.getElementById('tx-full-list');
      ul.innerHTML = list.length ? list.map(txRow).join('') : emptyState('No transactions match.', '+ Add transaction', () => openTransactionModal());
      bindTxRowActions(ul);
    };
    ['f-from', 'f-to', 'f-type', 'f-category', 'f-account'].forEach(id => document.getElementById(id).addEventListener('change', rerender));
    rerender();
  }
  function val(id) { const el = document.getElementById(id); return el.value || undefined; }

  /* ================= ACCOUNTS ================= */
  function renderAccounts(page) {
    page.innerHTML = `
    <div class="page-head"><h1>Accounts</h1><button class="btn-primary" id="acc-add">+ Add account</button></div>
    <div class="cards-grid" id="acc-list"></div>`;
    document.getElementById('acc-add').addEventListener('click', openAccountModal);
    const list = document.getElementById('acc-list');
    if (!S.state.accounts.length) { list.innerHTML = emptyState('No accounts yet.', '+ Add account', openAccountModal); return; }
    list.innerHTML = S.state.accounts.map(a => `
      <div class="card acc-card">
        <div class="card-head"><h3>${escapeHtml(a.name)}</h3><span class="tag">${escapeHtml(a.type)}</span></div>
        <div class="big-number">${fmt(S.accountBalance(a.id))}</div>
        <div class="card-actions">
          <button class="btn-ghost small acc-edit" data-id="${a.id}">Edit</button>
          <button class="btn-ghost small acc-del" data-id="${a.id}">Delete</button>
        </div>
      </div>`).join('');
    list.querySelectorAll('.acc-edit').forEach(b => b.addEventListener('click', () => openAccountModal(S.state.accounts.find(a => a.id === b.dataset.id))));
    list.querySelectorAll('.acc-del').forEach(b => b.addEventListener('click', () => { S.deleteAccount(b.dataset.id); toast('Account deleted'); }));
  }

  /* ================= PEOPLE ================= */
  function renderPeople(page) {
    page.innerHTML = `
    <div class="page-head"><h1>People</h1><button class="btn-primary" id="person-add">+ Add person</button></div>
    <div class="cards-grid" id="people-list"></div>`;
    document.getElementById('person-add').addEventListener('click', openPersonModal);
    const list = document.getElementById('people-list');
    if (!S.state.people.length) { list.innerHTML = emptyState('No people yet — add friends you lend to or borrow from.', '+ Add person', openPersonModal); return; }
    list.innerHTML = S.state.people.map(p => {
      const bal = S.personBalance(p.id);
      const text = bal > 0 ? `Owes you ${fmt(bal)}` : bal < 0 ? `You owe ${fmt(-bal)}` : 'Settled up';
      return `<div class="card person-card" data-id="${p.id}">
        <div class="card-head"><h3>${escapeHtml(p.name)}</h3></div>
        <div class="big-number ${bal > 0 ? 'pos' : bal < 0 ? 'neg' : ''}">${text}</div>
        <div class="card-actions">
          <button class="btn-ghost small p-lend" data-id="${p.id}">Lend</button>
          <button class="btn-ghost small p-repay" data-id="${p.id}">Repayment</button>
          <button class="btn-ghost small p-ledger" data-id="${p.id}">Ledger</button>
        </div>
      </div>`;
    }).join('');
    list.querySelectorAll('.p-lend').forEach(b => b.addEventListener('click', () => openTransactionModal(null, { type: 'lend', personId: b.dataset.id })));
    list.querySelectorAll('.p-repay').forEach(b => b.addEventListener('click', () => {
      const bal = S.personBalance(b.dataset.id);
      openTransactionModal(null, { type: bal >= 0 ? 'repay_received' : 'repay_paid', personId: b.dataset.id });
    }));
    list.querySelectorAll('.p-ledger').forEach(b => b.addEventListener('click', () => openLedgerModal(b.dataset.id)));
  }

  function openLedgerModal(personId) {
    const person = S.state.people.find(p => p.id === personId);
    const ledger = S.personLedger(personId);
    const bal = S.personBalance(personId);
    modal(`Ledger — ${escapeHtml(person.name)}`, `
      <p class="muted">${bal > 0 ? `${escapeHtml(person.name)} owes you ${fmt(bal)}` : bal < 0 ? `You owe ${escapeHtml(person.name)} ${fmt(-bal)}` : 'All settled up.'}</p>
      ${ledger.length ? `<ul class="simple-list">${ledger.map(t => `<li><span>${t.date}</span><span>${t.type.replace('_', ' ')}</span><span>${fmt(t.amount)}</span></li>`).join('')}</ul>` : emptyState('No history yet.', null)}
    `);
  }

  /* ================= BUDGETS (envelope-style budget accounts) ================= */
  function budgetStatusTag(status) {
    return status === 'Over Budget' ? 'tag-danger' : status === 'Completed' ? '' : '';
  }
  function envelopeCard(stat) {
    const e = stat.envelope;
    const pctClamped = Math.min(100, Math.max(0, stat.pct));
    const barClass = stat.status === 'Over Budget' ? 'danger' : stat.pct >= 75 ? 'warn' : '';
    return `<div class="card env-card" data-id="${e.id}" tabindex="0" role="button">
      <div class="card-head">
        <h3>${escapeHtml(e.name)}</h3>
        <span class="tag ${budgetStatusTag(stat.status)}">${stat.status === 'Over Budget' ? '⚠️ Over Budget' : stat.status}</span>
      </div>
      <div class="big-number ${stat.balance < 0 ? 'neg' : ''}">${fmt(stat.balance)}<span class="muted small"> remaining</span></div>
      <div class="progress-bar"><div class="progress-fill ${barClass}" style="width:${pctClamped}%"></div></div>
      <div class="muted small">${fmt(stat.totalSpent)} spent of ${fmt(stat.totalAvailable)} · ${stat.pct}% used</div>
      <div class="muted small">${stat.txCount} transaction${stat.txCount === 1 ? '' : 's'} · created ${e.createdAt.slice(0, 10)}</div>
    </div>`;
  }
  function renderBudgets(page) {
    page.innerHTML = `
    <div class="page-head"><h1>Budgets</h1><button class="btn-primary" id="env-add">+ Create budget</button></div>
    <section class="kpi-grid" id="env-dash-kpis"></section>
    <div class="filter-bar">
      <input type="text" id="env-search" placeholder="Search budgets…">
      <select id="env-sort">
        <option value="">Sort: default</option>
        <option value="active">Active first</option>
        <option value="highest_spend">Highest spending</option>
        <option value="lowest_spend">Lowest spending</option>
        <option value="recent">Recently created</option>
        <option value="name">Name</option>
      </select>
    </div>
    <div class="cards-grid" id="env-list"></div>
    ${S.state.envelopes.length ? `<div class="card"><h3>Spending by budget</h3><canvas id="chart-env-spend"></canvas></div>` : ''}
    <div class="card">
      <div class="card-head"><h3>Category spending limits</h3><button class="btn-ghost small" id="catbudget-add">+ Set limit</button></div>
      <p class="muted small">Separate from budgets above — this is a simple monthly cap per spending category (e.g. "Food ≤ ₹3,500/month").</p>
      <div id="catbudget-list"></div>
    </div>`;

    const totals = S.envelopeDashboardTotals();
    document.getElementById('env-dash-kpis').innerHTML = `
      <div class="kpi kpi-primary"><span class="kpi-label">Total funds</span><span class="kpi-value">${fmt(totals.totalFunds)}</span></div>
      <div class="kpi"><span class="kpi-label">Total added</span><span class="kpi-value">${fmt(totals.totalAdded)}</span></div>
      <div class="kpi"><span class="kpi-label">Total spent</span><span class="kpi-value neg">${fmt(totals.totalSpent)}</span></div>
      <div class="kpi"><span class="kpi-label">Total remaining</span><span class="kpi-value pos">${fmt(totals.totalRemaining)}</span></div>
      <div class="kpi"><span class="kpi-label">Budgets</span><span class="kpi-value">${totals.count}</span></div>`;

    document.getElementById('env-add').addEventListener('click', () => openEnvelopeModal());
    document.getElementById('catbudget-add').addEventListener('click', openCategoryBudgetModal);

    const rerenderList = () => {
      const q = document.getElementById('env-search').value;
      const sortBy = document.getElementById('env-sort').value;
      let stats = S.searchEnvelopes(q);
      stats = S.sortEnvelopeStats(stats, sortBy);
      const list = document.getElementById('env-list');
      list.innerHTML = stats.length ? stats.map(envelopeCard).join('') : emptyState('No budgets created yet.', '+ Create Your First Budget', () => openEnvelopeModal());
      list.querySelectorAll('.env-card').forEach(card => {
        card.addEventListener('click', () => { location.hash = `#budget/${card.dataset.id}`; });
        card.addEventListener('keypress', (e) => { if (e.key === 'Enter') location.hash = `#budget/${card.dataset.id}`; });
      });
    };
    document.getElementById('env-search').addEventListener('input', rerenderList);
    document.getElementById('env-sort').addEventListener('change', rerenderList);
    rerenderList();

    const chartCanvas = document.getElementById('chart-env-spend');
    if (chartCanvas) {
      const all = S.allEnvelopeStats();
      charts.envSpend = new Chart(chartCanvas, {
        type: 'bar',
        data: { labels: all.map(s => s.envelope.name), datasets: [{ label: 'Spent', data: all.map(s => s.totalSpent), backgroundColor: palette(all.length) }] },
        options: chartOpts()
      });
    }

    // legacy category-cap budgets, unchanged behaviour
    const status = S.budgetStatus();
    const catList = document.getElementById('catbudget-list');
    catList.innerHTML = status.length ? status.map(b => `
      <div class="cat-budget-row">
        <span>${escapeHtml(b.category)}</span>
        <div class="progress-bar" style="flex:1;margin:0 12px"><div class="progress-fill ${b.pct >= 100 ? 'danger' : b.pct >= 75 ? 'warn' : ''}" style="width:${Math.min(100, b.pct)}%"></div></div>
        <span class="muted small">${fmt(b.spent)} / ${fmt(b.monthlyAmount)}</span>
      </div>`).join('') : `<p class="muted small">No category limits set.</p>`;
  }

  /* ---- Budget Details (full screen) ---- */
  let envDetailFilters = {};
  function renderBudgetDetails(page, envelopeId) {
    const stat = S.envelopeStats(envelopeId);
    if (!stat) { location.hash = '#budgets'; return; }
    const e = stat.envelope;
    envDetailFilters = envDetailFilters.envelopeId === envelopeId ? envDetailFilters : { envelopeId };
    const pctClamped = Math.min(100, Math.max(0, stat.pct));
    const barClass = stat.status === 'Over Budget' ? 'danger' : stat.pct >= 75 ? 'warn' : '';

    page.innerHTML = `
    <div class="page-head">
      <div class="detail-title-row"><button class="icon-btn" id="env-back">←</button><h1>${escapeHtml(e.name)}</h1></div>
      <div class="card-actions">
        <button class="btn-ghost small" id="env-edit">Edit</button>
        <button class="btn-ghost small danger" id="env-delete">Delete</button>
      </div>
    </div>

    <section class="card">
      <div class="card-head"><h3>Budget overview</h3><span class="tag ${budgetStatusTag(stat.status)}">${stat.status === 'Over Budget' ? '⚠️ Over Budget' : stat.status}</span></div>
      <div class="row-stats">
        <div><span class="muted">Initial budget</span><div class="stat">${fmt(e.initialAmount)}</div></div>
        <div><span class="muted">Total added</span><div class="stat pos">${fmt(stat.totalAdded)}</div></div>
        <div><span class="muted">Total spent</span><div class="stat neg">${fmt(stat.totalSpent)}</div></div>
        <div><span class="muted">Available balance</span><div class="stat ${stat.balance < 0 ? 'neg' : ''}">${fmt(stat.balance)}</div></div>
      </div>
      <div class="progress-bar"><div class="progress-fill ${barClass}" style="width:${pctClamped}%"></div></div>
      <div class="muted small">${stat.pct}% used · ${stat.txCount} transaction${stat.txCount === 1 ? '' : 's'}${e.endDate ? ' · ends ' + e.endDate : ''}</div>
      ${e.description ? `<p class="muted small">${escapeHtml(e.description)}</p>` : ''}
      ${e.notes ? `<p class="muted small">Notes: ${escapeHtml(e.notes)}</p>` : ''}
      <div class="card-actions">
        <button class="btn-primary" id="env-add-expense">+ Add expense</button>
        <button class="btn-ghost" id="env-add-money">+ Add money</button>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>Transaction history</h3></div>
      <div class="filter-bar">
        <input type="text" id="env-tx-search" placeholder="Search transactions…">
        <select id="env-tx-kind"><option value="">All</option><option value="expense">Expenses</option><option value="addition">Money added</option></select>
        <select id="env-tx-range"><option value="">All time</option><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="week">This week</option><option value="month">This month</option><option value="last_month">Last month</option></select>
      </div>
      <ul class="tx-list" id="env-tx-list"></ul>
    </section>`;

    document.getElementById('env-back').addEventListener('click', () => { location.hash = '#budgets'; });
    document.getElementById('env-edit').addEventListener('click', () => openEnvelopeModal(e));
    document.getElementById('env-delete').addEventListener('click', () => confirmDeleteEnvelope(e));
    document.getElementById('env-add-expense').addEventListener('click', () => openEnvelopeTxModal(e.id, 'expense'));
    document.getElementById('env-add-money').addEventListener('click', () => openEnvelopeTxModal(e.id, 'addition'));

    const rerenderTx = () => {
      const kind = document.getElementById('env-tx-kind').value;
      const range = document.getElementById('env-tx-range').value;
      const query = document.getElementById('env-tx-search').value;
      const { dateFrom, dateTo } = dateRangeFor(range);
      const list = S.filterEnvelopeTransactions(envelopeId, { kind, dateFrom, dateTo, query });
      const ul = document.getElementById('env-tx-list');
      ul.innerHTML = list.length ? list.map(envTxRow).join('') : emptyState('No transactions yet.', '+ Add Expense', () => openEnvelopeTxModal(envelopeId, 'expense'));
      ul.querySelectorAll('.env-tx-row').forEach(row => row.addEventListener('click', (ev) => {
        if (ev.target.closest('.tx-delete') || ev.target.closest('.tx-edit')) return;
        openEnvelopeTxDetailsModal(list.find(t => t.id === row.dataset.id));
      }));
      ul.querySelectorAll('.tx-edit').forEach(b => b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const t = list.find(t => t.id === b.closest('.env-tx-row').dataset.id);
        openEnvelopeTxModal(envelopeId, t.envelopeKind, t);
      }));
      ul.querySelectorAll('.tx-delete').forEach(b => b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const id = b.closest('.env-tx-row').dataset.id;
        confirmDeleteEnvelopeTx(id);
      }));
    };
    ['env-tx-kind', 'env-tx-range', 'env-tx-search'].forEach(id => document.getElementById(id).addEventListener('input', rerenderTx));
    rerenderTx();
  }

  function envTxRow(t) {
    const isAdd = t.envelopeKind === 'addition';
    return `<li class="tx-row env-tx-row" data-id="${t.id}" style="cursor:pointer">
      <div class="tx-main">
        <span class="tx-cat">${isAdd ? '🟢' : '🔴'} ${escapeHtml(t.merchant || t.category)}</span>
        <span class="muted small">${t.date}${t.time ? ' · ' + t.time : ''} · balance after: ${fmt(t.runningBalance)}</span>
      </div>
      <span class="tx-amount ${isAdd ? 'pos' : 'neg'}">${isAdd ? '+' : '−'}${fmt(t.amount)}</span>
      <button class="icon-btn tx-edit" title="Edit">✎</button>
      <button class="icon-btn tx-delete" title="Delete">🗑</button>
    </li>`;
  }

  function dateRangeFor(preset) {
    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    if (preset === 'today') return { dateFrom: iso(today), dateTo: iso(today) };
    if (preset === 'yesterday') { const y = new Date(today); y.setDate(y.getDate() - 1); return { dateFrom: iso(y), dateTo: iso(y) }; }
    if (preset === 'week') { const w = new Date(today); w.setDate(w.getDate() - 7); return { dateFrom: iso(w), dateTo: iso(today) }; }
    if (preset === 'month') { const m = new Date(today.getFullYear(), today.getMonth(), 1); return { dateFrom: iso(m), dateTo: iso(today) }; }
    if (preset === 'last_month') { const s = new Date(today.getFullYear(), today.getMonth() - 1, 1); const en = new Date(today.getFullYear(), today.getMonth(), 0); return { dateFrom: iso(s), dateTo: iso(en) }; }
    return {};
  }

  /* ---- Transaction details modal (within a budget) ---- */
  function openEnvelopeTxDetailsModal(t) {
    if (!t) return;
    const isAdd = t.envelopeKind === 'addition';
    modal(isAdd ? 'Money added — details' : 'Expense — details', `
      <ul class="simple-list">
        <li><span>Type</span><span>${isAdd ? 'Money Added' : 'Expense'}</span></li>
        <li><span>Amount</span><span>${fmt(t.amount)}</span></li>
        <li><span>Title</span><span>${escapeHtml(t.merchant || '')}</span></li>
        <li><span>Category</span><span>${escapeHtml(t.category || '')}</span></li>
        <li><span>Date</span><span>${t.date}</span></li>
        <li><span>Time</span><span>${t.time || '—'}</span></li>
        <li><span>Payment method</span><span>${escapeHtml(t.paymentMethod || '—')}</span></li>
        <li><span>Description</span><span>${escapeHtml(t.note || '—')}</span></li>
        <li><span>Notes</span><span>${escapeHtml(t.notes || '—')}</span></li>
        <li><span>Balance after</span><span>${fmt(t.runningBalance)}</span></li>
      </ul>
      ${t.receipt && t.receipt.dataUrl ? `<img src="${t.receipt.dataUrl}" alt="receipt" style="max-width:100%;border-radius:10px;margin-top:10px">` : ''}
    `, `<button class="btn-ghost" id="etx-close">Close</button><button class="btn-ghost" id="etx-edit-btn">Edit</button><button class="btn-ghost danger" id="etx-delete-btn">Delete</button>`);
    document.getElementById('etx-close').addEventListener('click', closeModal);
    document.getElementById('etx-edit-btn').addEventListener('click', () => { closeModal(); openEnvelopeTxModal(t.envelopeId, t.envelopeKind, t); });
    document.getElementById('etx-delete-btn').addEventListener('click', () => { closeModal(); confirmDeleteEnvelopeTx(t.id); });
  }

  function confirmDeleteEnvelopeTx(id) {
    const t = S.state.transactions.find(t => t.id === id);
    if (!t) return;
    modal('Delete this transaction?', `<p>Delete this ${t.envelopeKind === 'addition' ? 'addition' : 'expense'} of ${fmt(t.amount)}${t.merchant ? ' — ' + escapeHtml(t.merchant) : ''}? This will recalculate the budget balance.</p>`,
      `<button class="btn-ghost" id="del-cancel">Cancel</button><button class="btn-ghost danger" id="del-confirm">Delete</button>`);
    document.getElementById('del-cancel').addEventListener('click', closeModal);
    document.getElementById('del-confirm').addEventListener('click', () => {
      const removed = S.deleteTransaction(id);
      closeModal();
      toast('Transaction deleted', 'UNDO', () => S.restoreTransaction(removed));
    });
  }

  function confirmDeleteEnvelope(env) {
    modal(`Delete "${escapeHtml(env.name)}"?`, `<p>All transactions associated with this budget will also be deleted. This cannot be undone.</p>`,
      `<button class="btn-ghost" id="del-env-cancel">Cancel</button><button class="btn-ghost danger" id="del-env-confirm">Delete budget</button>`);
    document.getElementById('del-env-cancel').addEventListener('click', closeModal);
    document.getElementById('del-env-confirm').addEventListener('click', () => {
      S.deleteEnvelope(env.id);
      closeModal();
      toast('Budget deleted');
      location.hash = '#budgets';
    });
  }

  function openEnvelopeModal(existing) {
    modal(existing ? 'Edit budget' : 'Create budget', `
      <form id="env-form" class="stacked-form">
        <label>Budget name<input name="name" required value="${escapeHtml(existing ? existing.name : '')}" placeholder="e.g. Travel"></label>
        <label>Initial amount<input name="initialAmount" type="number" min="0" step="0.01" required value="${existing ? existing.initialAmount : ''}"></label>
        <label>Category<select name="category">${categoryOptions(existing ? existing.category : undefined)}</select></label>
        <label>Description (optional)<input name="description" value="${escapeHtml(existing ? existing.description : '')}"></label>
        <label>Start date<input name="startDate" type="date" value="${existing ? existing.startDate : H.todayISO()}"></label>
        <label>End date (optional)<input name="endDate" type="date" value="${existing && existing.endDate ? existing.endDate : ''}"></label>
        <label>Notes (optional)<input name="notes" value="${escapeHtml(existing ? existing.notes : '')}"></label>
      </form>`,
      `<button class="btn-ghost" id="env-cancel">Cancel</button><button class="btn-primary" id="env-save">Save</button>`
    );
    document.getElementById('env-cancel').addEventListener('click', closeModal);
    let saving = false;
    document.getElementById('env-save').addEventListener('click', () => {
      if (saving) return;
      const f = new FormData(document.getElementById('env-form'));
      const name = (f.get('name') || '').trim();
      const amount = Number(f.get('initialAmount'));
      if (!name) { toast('Budget name is required'); return; }
      if (isNaN(amount) || amount < 0) { toast('Enter a valid initial amount'); return; }
      saving = true;
      const payload = {
        name, initialAmount: amount, category: f.get('category'), description: f.get('description'),
        startDate: f.get('startDate'), endDate: f.get('endDate') || null, notes: f.get('notes')
      };
      try {
        if (existing) S.updateEnvelope(existing.id, payload); else S.addEnvelope(payload);
        closeModal(); toast(existing ? 'Budget updated' : 'Budget created');
      } catch (err) { toast(err.message); saving = false; }
    });
  }

  function openEnvelopeTxModal(envelopeId, kind, existing) {
    const isAdd = kind === 'addition';
    modal(existing ? `Edit ${isAdd ? 'addition' : 'expense'}` : (isAdd ? 'Add money' : 'Add expense'), `
      <form id="etx-form" class="stacked-form">
        <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required value="${existing ? existing.amount : ''}"></label>
        <label>Title<input name="title" required value="${escapeHtml(existing ? existing.merchant : '')}" placeholder="${isAdd ? 'e.g. Additional travel money' : 'e.g. Tea'}"></label>
        ${isAdd ? '' : `<label>Category<select name="category">${categoryOptions(existing ? existing.category : undefined)}</select></label>`}
        <label>Date<input name="date" type="date" value="${existing ? existing.date : H.todayISO()}"></label>
        <label>Time<input name="time" type="time" value="${existing ? existing.time : new Date().toTimeString().slice(0, 5)}"></label>
        ${isAdd ? '' : `<label>Payment method<select name="paymentMethod"><option>Cash</option><option>UPI</option><option>Card</option><option>Bank transfer</option><option>Other</option></select></label>`}
        <label>Description<input name="description" value="${escapeHtml(existing ? existing.note : '')}"></label>
        <label>Notes<input name="notes" value="${escapeHtml(existing ? existing.notes : '')}"></label>
        ${isAdd ? '' : `<label>Receipt (optional)<input name="receipt" type="file" accept="image/*"></label>`}
      </form>`,
      `<button class="btn-ghost" id="etx-cancel">Cancel</button><button class="btn-primary" id="etx-save">${existing ? 'Save changes' : 'Save'}</button>`
    );
    document.getElementById('etx-cancel').addEventListener('click', closeModal);
    let saving = false;
    document.getElementById('etx-save').addEventListener('click', async () => {
      if (saving) return;
      const form = document.getElementById('etx-form');
      const f = new FormData(form);
      const amount = Number(f.get('amount'));
      const title = (f.get('title') || '').trim();
      if (!title) { toast('Title is required'); return; }
      if (isNaN(amount) || amount <= 0) { toast('Enter a valid amount greater than zero'); return; }
      saving = true;
      const payload = {
        amount, title, category: f.get('category'), date: f.get('date'), time: f.get('time'),
        paymentMethod: f.get('paymentMethod'), description: f.get('description'), notes: f.get('notes')
      };
      const fileInput = form.querySelector('input[name="receipt"]');
      const finish = () => {
        try {
          if (existing) {
            S.updateTransaction(existing.id, {
              amount: payload.amount, merchant: payload.title, category: payload.category || existing.category,
              date: payload.date, time: payload.time, paymentMethod: payload.paymentMethod,
              note: payload.description, notes: payload.notes, receipt: payload.receipt || existing.receipt
            });
          } else {
            S.addEnvelopeTransaction(envelopeId, kind, payload);
          }
          closeModal(); toast(existing ? 'Transaction updated' : (isAdd ? 'Money added' : 'Expense added'));
        } catch (err) { toast(err.message); saving = false; }
      };
      if (fileInput && fileInput.files && fileInput.files[0]) {
        const reader = new FileReader();
        reader.onload = () => { payload.receipt = { name: fileInput.files[0].name, dataUrl: reader.result }; finish(); };
        reader.onerror = finish;
        reader.readAsDataURL(fileInput.files[0]);
      } else {
        finish();
      }
    });
  }

  /* ================= GOALS ================= */
  function renderGoals(page) {
    page.innerHTML = `
    <div class="page-head"><h1>Savings goals</h1><button class="btn-primary" id="goal-add">+ New goal</button></div>
    <div class="cards-grid" id="goal-list"></div>`;
    document.getElementById('goal-add').addEventListener('click', openGoalModal);
    const list = document.getElementById('goal-list');
    if (!S.state.goals.length) { list.innerHTML = emptyState('No goals yet — add one for that laptop or trip.', '+ New goal', openGoalModal); return; }
    list.innerHTML = S.state.goals.map(g => {
      const pct = Math.min(100, Math.round((g.saved / (g.target || 1)) * 100));
      const proj = S.goalProjection(g);
      return `<div class="card">
        <div class="card-head"><h3>${escapeHtml(g.name)}</h3><span class="tag">${pct}%</span></div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="muted small">${fmt(g.saved)} of ${fmt(g.target)}${g.deadline ? ' · by ' + g.deadline : ''}</div>
        ${proj ? `<div class="muted small">On track to finish ~${proj.estCompletion}</div>` : ''}
        <div class="card-actions">
          <button class="btn-ghost small g-contribute" data-id="${g.id}">+ Add savings</button>
        </div>
      </div>`;
    }).join('');
    list.querySelectorAll('.g-contribute').forEach(b => b.addEventListener('click', () => {
      const amt = prompt('How much are you adding to this goal?');
      if (amt && !isNaN(Number(amt))) { S.contributeToGoal(b.dataset.id, Number(amt)); toast('Goal updated'); }
    }));
  }

  /* ================= BILLS / RECURRING ================= */
  function renderBills(page) {
    page.innerHTML = `
    <div class="page-head"><h1>Bills &amp; subscriptions</h1><button class="btn-primary" id="rec-add">+ Add recurring</button></div>
    <div class="card"><span class="muted">Estimated annual subscription cost</span><div class="big-number">${fmt(S.subscriptionAnnualCost())}</div></div>
    <div class="cards-grid" id="rec-list"></div>`;
    document.getElementById('rec-add').addEventListener('click', openRecurringModal);
    const list = document.getElementById('rec-list');
    if (!S.state.recurring.length) { list.innerHTML = emptyState('No recurring bills yet.', '+ Add recurring', openRecurringModal); return; }
    const todayStr = H.todayISO();
    list.innerHTML = S.state.recurring.map(r => {
      const overdue = r.nextDate < todayStr;
      return `<div class="card">
        <div class="card-head"><h3>${escapeHtml(r.name)}</h3><span class="tag ${overdue ? 'tag-danger' : ''}">${overdue ? 'Overdue' : r.kind}</span></div>
        <div class="big-number">${fmt(r.amount)}</div>
        <div class="muted small">${r.frequency} · next ${r.nextDate}</div>
        <div class="card-actions"><button class="btn-ghost small rec-pay" data-id="${r.id}">Mark paid</button></div>
      </div>`;
    }).join('');
    list.querySelectorAll('.rec-pay').forEach(b => b.addEventListener('click', () => { S.markRecurringPaid(b.dataset.id); toast('Marked as paid'); }));
  }

  /* ================= ANALYTICS ================= */
  function renderAnalytics(page) {
    const nw = S.needWantBreakdown();
    const health = S.financialHealthScore();
    const forecast = S.cashFlowForecast();
    page.innerHTML = `
    <div class="page-head"><h1>Analytics</h1></div>
    <section class="grid-2">
      <div class="card">
        <h3>Financial health score</h3>
        <div class="big-number">${health.score}<span class="muted small">/100</span></div>
        <ul class="simple-list">
          <li><span>Savings rate</span><span>${health.parts.savingsRate}</span></li>
          <li><span>Budget adherence</span><span>${health.parts.budgetAdherence}</span></li>
          <li><span>Debt factor</span><span>${health.parts.debtFactor}</span></li>
          <li><span>Goal progress</span><span>${health.parts.goalProgress}</span></li>
        </ul>
      </div>
      <div class="card">
        <h3>Need vs. want (this month)</h3>
        <canvas id="chart-nw"></canvas>
      </div>
    </section>
    <section class="card">
      <h3>Cash-flow forecast <span class="muted small">(estimate, not a guarantee)</span></h3>
      <div class="row-stats">
        <div><span class="muted">Current</span><div class="stat">${fmt(forecast.currentBalance)}</div></div>
        <div><span class="muted">Projected spend (rest of month)</span><div class="stat neg">${fmt(forecast.projectedExpense)}</div></div>
        <div><span class="muted">Predicted month-end</span><div class="stat">${fmt(forecast.predictedMonthEnd)}</div></div>
      </div>
    </section>
    <section class="card">
      <h3>What-if simulator</h3>
      <div class="whatif-row">
        <label>If I spend <input id="wi-daily" type="number" value="200" style="width:80px"> /day for the rest of the month:</label>
        <span id="wi-result" class="stat"></span>
      </div>
    </section>`;
    charts.nw = new Chart(document.getElementById('chart-nw'), {
      type: 'pie',
      data: { labels: ['Need', 'Want', 'Unclassified'], datasets: [{ data: [nw.need, nw.want, nw.unclassified], backgroundColor: ['#2e7d5b', '#c0533e', '#9a9a9a'] }] },
      options: { plugins: { legend: { position: 'bottom' } } }
    });
    const wi = document.getElementById('wi-daily');
    const updateWi = () => {
      const days = S.daysRemainingInMonth();
      const spend = Number(wi.value) * days;
      document.getElementById('wi-result').textContent = `≈ ${fmt(spend)} over ${days} days → est. balance ${fmt(S.totalBalance() - spend)}`;
    };
    wi.addEventListener('input', updateWi); updateWi();
  }

  /* ================= SETTINGS ================= */
  function renderSettings(page) {
    const p = S.state.profile;
    const driveConfigured = window.MyBillDrive && window.MyBillDrive.isConfigured();
    const driveConnected = window.MyBillDrive && window.MyBillDrive.isConnected();
    page.innerHTML = `
    <div class="page-head"><h1>Settings</h1></div>
    <section class="card">
      <h3>Profile</h3>
      <label>Name<input id="set-name" value="${escapeHtml(p.name)}"></label>
      <label>Monthly savings target<input id="set-savings" type="number" value="${p.savingsMonthlyTarget}"></label>
      <button class="btn-primary" id="save-profile">Save</button>
    </section>
    <section class="card">
      <h3>Google Drive</h3>
      ${driveConfigured
        ? `<p class="muted">${driveConnected ? 'Connected — your data syncs to your Drive automatically.' : 'Not connected yet.'}</p>
           <div class="card-actions">
             <button class="btn-primary" id="drive-connect">${driveConnected ? 'Disconnect' : 'Connect Google Drive'}</button>
             ${driveConnected ? `<button class="btn-ghost" id="drive-restore">Restore from Drive</button>` : ''}
           </div>`
        : `<p class="muted">Add your Google OAuth Client ID to <code>config.js</code> to enable Drive sync. See SETUP.md for the exact steps.</p>`}
    </section>
    <section class="card">
      <h3>Backup &amp; export</h3>
      <div class="card-actions">
        <button class="btn-ghost" id="export-json">Export JSON</button>
        <button class="btn-ghost" id="export-csv">Export CSV</button>
        <label class="btn-ghost file-btn">Import JSON<input type="file" id="import-file" accept=".json" hidden></label>
      </div>
    </section>
    <section class="card">
      <h3>Danger zone</h3>
      <button class="btn-ghost danger" id="reset-all">Delete all MYBILL data</button>
    </section>`;
    document.getElementById('save-profile').addEventListener('click', () => {
      p.name = document.getElementById('set-name').value;
      p.savingsMonthlyTarget = Number(document.getElementById('set-savings').value) || 0;
      S.save(); toast('Profile saved');
    });
    document.getElementById('export-json').addEventListener('click', () => downloadFile(`MYBILL_Backup_${H.todayISO()}.json`, S.exportJSON(), 'application/json'));
    document.getElementById('export-csv').addEventListener('click', () => downloadFile(`MYBILL_Transactions_${H.todayISO()}.csv`, S.exportCSV(), 'text/csv'));
    document.getElementById('import-file').addEventListener('change', (e) => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = () => { try { S.importJSON(reader.result); toast('Data imported'); router(); } catch (err) { toast('Import failed — invalid file'); } };
      reader.readAsText(file);
    });
    document.getElementById('reset-all').addEventListener('click', () => {
      if (confirm('This permanently deletes all MYBILL data in this browser. Continue?')) { S.resetAll(); location.reload(); }
    });
    if (driveConfigured) {
      document.getElementById('drive-connect').addEventListener('click', async () => {
        if (driveConnected) { window.MyBillDrive.disconnect(); router(); return; }
        try { await window.MyBillDrive.connect(); toast('Connected to Google Drive'); router(); }
        catch (e) { toast('Could not connect: ' + (e && e.message ? e.message : 'unknown error')); }
      });
      const restoreBtn = document.getElementById('drive-restore');
      if (restoreBtn) restoreBtn.addEventListener('click', () => {
        modal('Restore from Google Drive?', `<p>This replaces the data currently on this device with whatever is saved in your MYBILL Google Drive folder. Anything added on this device since the last sync that hasn't reached Drive yet will be lost.</p>`,
          `<button class="btn-ghost" id="restore-cancel">Cancel</button><button class="btn-primary" id="restore-confirm">Restore</button>`);
        document.getElementById('restore-cancel').addEventListener('click', closeModal);
        document.getElementById('restore-confirm').addEventListener('click', async () => {
          closeModal();
          try {
            const found = await window.MyBillDrive.restoreFromDrive();
            if (found) { toast('Data restored from Drive'); router(); }
            else toast('No data found in Drive for this account');
          } catch (e) { toast('Restore failed: ' + e.message); }
        });
      });
    }
  }

  function downloadFile(name, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
    toast(`Downloading ${name}…`);
  }

  /* ================= HELP ================= */
  function renderHelp(page) {
    page.innerHTML = `
    <div class="page-head"><h1>Help</h1></div>
    <div class="card help-card">
      <h3>Adding an expense</h3><p>Tap the + button, enter an amount and pick a category. Everything else is optional — you can add merchant, notes, and tags later.</p>
      <h3>How lending works</h3><p>Add a person under People, then use Lend / Repayment on their card. MYBILL keeps a running ledger so you always know who owes what.</p>
      <h3>Bill splitting</h3><p>Use "Add transaction" → Split bill to divide a shared cost; MYBILL creates the lending entries for you automatically.</p>
      <h3>Google Drive storage</h3><p>Once connected, your MYBILL folder in Drive is the backup copy of your data — you can restore from it on any device.</p>
      <h3>Backup &amp; restore</h3><p>Settings → Backup &amp; export lets you download a full JSON backup any time, and import it back in if you switch browsers.</p>
    </div>`;
  }

  /* ================= MODALS ================= */
  function modal(title, bodyHtml, footerHtml = '') {
    const r = document.getElementById('modal-root');
    r.innerHTML = `<div class="modal-overlay"><div class="modal">
      <div class="modal-head"><h2>${title}</h2><button class="icon-btn modal-close">✕</button></div>
      <div class="modal-body">${bodyHtml}</div>
      ${footerHtml ? `<div class="modal-foot">${footerHtml}</div>` : ''}
    </div></div>`;
    r.querySelector('.modal-close').addEventListener('click', closeModal);
    r.querySelector('.modal-overlay').addEventListener('click', (e) => { if (e.target.classList.contains('modal-overlay')) closeModal(); });
    return r;
  }
  function closeModal() { document.getElementById('modal-root').innerHTML = ''; }

  function accountOptions(selected) {
    return S.state.accounts.map(a => `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('');
  }
  function personOptions(selected) {
    return `<option value="">—</option>` + S.state.people.map(p => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
  }
  function categoryOptions(selected) {
    return Object.keys(S.state.categories).map(c => `<option value="${c}" ${c === selected ? 'selected' : ''}>${c}</option>`).join('');
  }

  function openQuickAddSheet() {
    modal('Quick add', `
      <div class="quick-grid">
        <button class="quick-btn" data-type="expense">Expense</button>
        <button class="quick-btn" data-type="income">Income</button>
        <button class="quick-btn" data-type="transfer">Transfer</button>
        <button class="quick-btn" data-type="lend">Lend</button>
        <button class="quick-btn" data-type="borrow">Borrow</button>
        <button class="quick-btn" data-type="repay_received">Repayment</button>
      </div>`);
    document.querySelectorAll('.quick-btn').forEach(b => b.addEventListener('click', () => { closeModal(); openTransactionModal(null, { type: b.dataset.type }); }));
  }

  function openTransactionModal(existing, presets = {}) {
    const t = existing || Object.assign({ date: H.todayISO(), time: new Date().toTimeString().slice(0, 5), type: 'expense' }, presets);
    if (!S.state.accounts.length) { toast('Add an account first'); openAccountModal(); return; }
    modal(existing ? 'Edit transaction' : 'Add transaction', `
      <form id="tx-form" class="stacked-form">
        <label>Type
          <select name="type" id="tx-type">
            ${['expense', 'income', 'transfer', 'lend', 'borrow', 'repay_received', 'repay_paid', 'refund', 'bill', 'subscription', 'adjustment'].map(o => `<option value="${o}" ${o === t.type ? 'selected' : ''}>${o.replace('_', ' ')}</option>`).join('')}
          </select>
        </label>
        <label>Amount<input name="amount" type="number" min="0" step="0.01" required value="${t.amount || ''}"></label>
        <label>Date<input name="date" type="date" value="${t.date}"></label>
        <label>Time<input name="time" type="time" value="${t.time || ''}"></label>
        <label class="cat-row">Category<select name="category">${categoryOptions(t.category)}</select></label>
        <label>Account<select name="accountId">${accountOptions(t.accountId)}</select></label>
        <label class="to-account-row" style="display:${t.type === 'transfer' ? 'block' : 'none'}">To account<select name="toAccountId">${accountOptions(t.toAccountId)}</select></label>
        <label class="person-row" style="display:${['lend', 'borrow', 'repay_received', 'repay_paid'].includes(t.type) ? 'block' : 'none'}">Person<select name="personId">${personOptions(t.personId)}</select></label>
        <label>Merchant / label<input name="merchant" value="${escapeHtml(t.merchant || '')}"></label>
        <label>Note<input name="note" value="${escapeHtml(t.note || '')}"></label>
        <label>Need or want
          <select name="needWant"><option value="">—</option><option value="need" ${t.needWant === 'need' ? 'selected' : ''}>Need</option><option value="want" ${t.needWant === 'want' ? 'selected' : ''}>Want</option></select>
        </label>
      </form>`,
      `<button class="btn-ghost" id="tx-cancel">Cancel</button><button class="btn-primary" id="tx-save">${existing ? 'Save changes' : 'Save'}</button>`
    );
    document.getElementById('tx-cancel').addEventListener('click', closeModal);
    document.getElementById('tx-type').addEventListener('change', (e) => {
      const v = e.target.value;
      document.querySelector('.to-account-row').style.display = v === 'transfer' ? 'block' : 'none';
      document.querySelector('.person-row').style.display = ['lend', 'borrow', 'repay_received', 'repay_paid'].includes(v) ? 'block' : 'none';
    });
    document.getElementById('tx-save').addEventListener('click', () => {
      const f = new FormData(document.getElementById('tx-form'));
      const payload = {
        type: f.get('type'), amount: Number(f.get('amount')), date: f.get('date'), time: f.get('time'),
        category: f.get('category'), accountId: f.get('accountId') || undefined,
        toAccountId: f.get('toAccountId') || undefined, personId: f.get('personId') || undefined,
        merchant: f.get('merchant'), note: f.get('note'), needWant: f.get('needWant') || null
      };
      if (!payload.amount || payload.amount <= 0) { toast('Enter a valid amount'); return; }
      if (existing) S.updateTransaction(existing.id, payload); else S.addTransaction(payload);
      closeModal(); toast(existing ? 'Transaction updated' : 'Transaction added');
    });
  }

  function openAccountModal(existing) {
    modal(existing ? 'Edit account' : 'Add account', `
      <form id="acc-form" class="stacked-form">
        <label>Name<input name="name" required value="${escapeHtml(existing ? existing.name : '')}"></label>
        <label>Type
          <select name="type">${['Cash', 'Bank', 'UPI', 'Wallet', 'Credit Card'].map(o => `<option ${existing && existing.type === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
        </label>
        <label>Opening balance<input name="openingBalance" type="number" value="${existing ? existing.openingBalance : 0}"></label>
      </form>`,
      `<button class="btn-ghost" id="acc-cancel">Cancel</button><button class="btn-primary" id="acc-save">Save</button>`
    );
    document.getElementById('acc-cancel').addEventListener('click', closeModal);
    document.getElementById('acc-save').addEventListener('click', () => {
      const f = new FormData(document.getElementById('acc-form'));
      const data = { name: f.get('name'), type: f.get('type'), openingBalance: Number(f.get('openingBalance')) || 0 };
      if (existing) S.updateAccount(existing.id, data); else S.addAccount(data);
      closeModal(); toast('Account saved');
    });
  }

  function openPersonModal() {
    modal('Add person', `<form id="person-form" class="stacked-form"><label>Name<input name="name" required></label><label>Note<input name="note"></label></form>`,
      `<button class="btn-ghost" id="person-cancel">Cancel</button><button class="btn-primary" id="person-save">Save</button>`);
    document.getElementById('person-cancel').addEventListener('click', closeModal);
    document.getElementById('person-save').addEventListener('click', () => {
      const f = new FormData(document.getElementById('person-form'));
      if (!f.get('name')) { toast('Enter a name'); return; }
      S.addPerson(f.get('name'), f.get('note')); closeModal(); toast('Person added');
    });
  }

  function openCategoryBudgetModal() {
    modal('Set category spending limit', `
      <form id="catbudget-form" class="stacked-form">
        <label>Category<select name="category">${categoryOptions()}</select></label>
        <label>Monthly amount<input name="amount" type="number" min="0" required></label>
      </form>`,
      `<button class="btn-ghost" id="catbudget-cancel">Cancel</button><button class="btn-primary" id="catbudget-save">Save</button>`);
    document.getElementById('catbudget-cancel').addEventListener('click', closeModal);
    document.getElementById('catbudget-save').addEventListener('click', () => {
      const f = new FormData(document.getElementById('catbudget-form'));
      S.setBudget(f.get('category'), Number(f.get('amount')) || 0);
      closeModal(); toast('Category limit saved'); router();
    });
  }

  function openGoalModal() {
    modal('New savings goal', `
      <form id="goal-form" class="stacked-form">
        <label>Goal name<input name="name" required placeholder="e.g. Laptop"></label>
        <label>Target amount<input name="target" type="number" min="0" required></label>
        <label>Deadline (optional)<input name="deadline" type="date"></label>
        <label>Monthly contribution<input name="monthlyContribution" type="number" min="0"></label>
      </form>`,
      `<button class="btn-ghost" id="goal-cancel">Cancel</button><button class="btn-primary" id="goal-save">Save</button>`);
    document.getElementById('goal-cancel').addEventListener('click', closeModal);
    document.getElementById('goal-save').addEventListener('click', () => {
      const f = new FormData(document.getElementById('goal-form'));
      if (!f.get('name') || !f.get('target')) { toast('Fill in name and target'); return; }
      S.addGoal({ name: f.get('name'), target: f.get('target'), deadline: f.get('deadline'), monthlyContribution: f.get('monthlyContribution') });
      closeModal(); toast('Goal created');
    });
  }

  function openRecurringModal() {
    modal('Add recurring', `
      <form id="rec-form" class="stacked-form">
        <label>Name<input name="name" required placeholder="e.g. Hostel rent"></label>
        <label>Amount<input name="amount" type="number" min="0" required></label>
        <label>Kind<select name="kind"><option value="bill">Bill</option><option value="subscription">Subscription</option><option value="expense">Recurring expense</option></select></label>
        <label>Category<select name="category">${categoryOptions()}</select></label>
        <label>Account<select name="account">${accountOptions()}</select></label>
        <label>Frequency<select name="frequency"><option value="monthly">Monthly</option><option value="weekly">Weekly</option><option value="daily">Daily</option><option value="yearly">Yearly</option></select></label>
        <label>Next due date<input name="nextDate" type="date" value="${H.todayISO()}" required></label>
      </form>`,
      `<button class="btn-ghost" id="rec-cancel">Cancel</button><button class="btn-primary" id="rec-save">Save</button>`);
    document.getElementById('rec-cancel').addEventListener('click', closeModal);
    document.getElementById('rec-save').addEventListener('click', () => {
      const f = new FormData(document.getElementById('rec-form'));
      S.addRecurring({
        name: f.get('name'), amount: Number(f.get('amount')), kind: f.get('kind'),
        category: f.get('category'), account: f.get('account'), frequency: f.get('frequency'), nextDate: f.get('nextDate')
      });
      closeModal(); toast('Recurring item added');
    });
  }

  /* ---------------- Global search ---------------- */
  function onSearchInput(e) {
    const q = e.target.value;
    const box = document.getElementById('search-results');
    if (!q.trim()) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const results = S.search(q).slice(0, 8);
    box.classList.remove('hidden');
    box.innerHTML = results.length
      ? results.map(t => `<div class="search-item">${escapeHtml(t.merchant || t.category || t.type)} · ${fmt(t.amount)} · ${t.date}</div>`).join('')
      : `<div class="search-item muted">No matches</div>`;
  }
  document.addEventListener('click', (e) => {
    const box = document.getElementById('search-results');
    if (box && !e.target.closest('.search-wrap')) { box.classList.add('hidden'); }
  });

  init();
})();

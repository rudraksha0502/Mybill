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
    root.innerHTML = `
    <div class="onboard-screen">
      <div class="onboard-card">
        <div class="brand"><span class="brand-mark">M</span>MYBILL</div>
        <p class="tagline">Your Personal Finance OS</p>
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
    document.getElementById('hamburger').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));
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
    const hash = (location.hash || '#dashboard').replace('#', '');
    const route = ROUTES.includes(hash) ? hash : 'dashboard';
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
    const sign = ['income', 'refund', 'repay_received', 'borrow'].includes(t.type) ? '+' : (t.type === 'transfer' ? '↔' : '−');
    const cls = sign === '+' ? 'pos' : (sign === '↔' ? '' : 'neg');
    return `<li class="tx-row" data-id="${t.id}">
      <div class="tx-main">
        <span class="tx-cat">${escapeHtml(t.merchant || t.category || t.type)}</span>
        <span class="muted small">${t.date} · ${acc ? escapeHtml(acc.name) : ''}${person ? ' · ' + escapeHtml(person.name) : ''}</span>
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

  /* ================= BUDGETS ================= */
  function renderBudgets(page) {
    const status = S.budgetStatus();
    page.innerHTML = `
    <div class="page-head"><h1>Budgets</h1><button class="btn-primary" id="budget-add">+ Set budget</button></div>
    <div class="cards-grid" id="budget-list"></div>`;
    document.getElementById('budget-add').addEventListener('click', openBudgetModal);
    const list = document.getElementById('budget-list');
    if (!status.length) { list.innerHTML = emptyState('No budgets set yet.', '+ Set budget', openBudgetModal); return; }
    list.innerHTML = status.map(b => `
      <div class="card">
        <div class="card-head"><h3>${escapeHtml(b.category)}</h3><span class="tag ${b.pct >= 100 ? 'tag-danger' : b.pct >= 75 ? 'tag-warn' : ''}">${b.pct}%</span></div>
        <div class="progress-bar"><div class="progress-fill ${b.pct >= 100 ? 'danger' : b.pct >= 75 ? 'warn' : ''}" style="width:${Math.min(100, b.pct)}%"></div></div>
        <div class="muted small">${fmt(b.spent)} spent of ${fmt(b.monthlyAmount)} · ${fmt(Math.max(0, b.remaining))} remaining</div>
      </div>`).join('');
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
           <button class="btn-primary" id="drive-connect">${driveConnected ? 'Disconnect' : 'Connect Google Drive'}</button>`
        : `<p class="muted">Add your Google OAuth Client ID to <code>js/config.js</code> to enable Drive sync. See SETUP.md for the exact steps.</p>`}
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
        catch (e) { toast('Could not connect: ' + e.message); }
      });
    }
  }

  function downloadFile(name, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
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

  function openBudgetModal() {
    modal('Set budget', `
      <form id="budget-form" class="stacked-form">
        <label>Category<select name="category">${categoryOptions()}</select></label>
        <label>Monthly amount<input name="amount" type="number" min="0" required></label>
      </form>`,
      `<button class="btn-ghost" id="budget-cancel">Cancel</button><button class="btn-primary" id="budget-save">Save</button>`);
    document.getElementById('budget-cancel').addEventListener('click', closeModal);
    document.getElementById('budget-save').addEventListener('click', () => {
      const f = new FormData(document.getElementById('budget-form'));
      S.setBudget(f.get('category'), Number(f.get('amount')) || 0);
      closeModal(); toast('Budget saved');
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

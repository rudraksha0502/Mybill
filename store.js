/* MYBILL — Data Engine
 * Single source of truth for all financial data.
 * Persists to localStorage now; Drive sync (drive.js) mirrors the same
 * shape to the user's own Google Drive when connected.
 *
 * Everything downstream (dashboard, analytics, budgets, safe-to-spend)
 * is DERIVED from the transaction list — nothing is double-stored,
 * so editing/deleting a transaction can never leave stale totals behind.
 */

const MYBILL_VERSION = '1.0.0';
const STORAGE_KEY = 'mybill_data_v1';

function uid() {
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

/* ---------- Default categories ---------- */
const DEFAULT_CATEGORIES = {
  Food: ['Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Tea/Coffee', 'Restaurant', 'Online Food', 'Mess'],
  Hostel: ['Rent', 'Mess', 'Electricity', 'Laundry', 'Cleaning', 'Wi-Fi', 'Room items', 'Maintenance'],
  Education: ['Books', 'Stationery', 'Printing', 'Projects', 'Courses', 'Exams', 'College fees'],
  Travel: ['Auto', 'Bus', 'Train', 'Cab', 'Fuel', 'Tickets'],
  Personal: ['Clothes', 'Grooming', 'Haircut', 'Shopping', 'Entertainment', 'Gaming'],
  Health: ['Medicine', 'Doctor', 'Fitness'],
  Other: ['Misc']
};

const INCOME_SOURCES = ['Home/Pocket Money', 'Salary', 'Internship', 'Freelancing', 'Scholarship', 'Refund', 'Gift', 'Other'];

const DEFAULT_STATE = () => ({
  version: MYBILL_VERSION,
  profile: {
    onboarded: false,
    name: '',
    currency: 'INR',
    currencySymbol: '₹',
    monthStartDay: 1,
    isStudent: true,
    savingsMonthlyTarget: 0,
    theme: 'light'
  },
  accounts: [],       // {id, name, type, openingBalance, active, createdAt}
  categories: DEFAULT_CATEGORIES,
  transactions: [],   // see TX shape below
  people: [],         // {id, name, note, createdAt}
  budgets: [],        // {id, category, monthlyAmount} — legacy monthly category-cap budgets, kept as-is
  envelopes: [],      // {id, name, initialAmount, category, description, startDate, endDate, color, notes, createdAt, updatedAt} — new budget-as-account feature
  goals: [],          // {id, name, target, saved, deadline, monthlyContribution}
  recurring: [],      // {id, name, amount, category, account, frequency, nextDate, kind: 'expense'|'subscription'|'bill', active}
  settings: {
    lowBalanceThreshold: 500,
    budgetAlertThresholds: [50, 75, 90, 100]
  },
  meta: {
    lastBackup: null,
    createdAt: nowISO()
  }
});

/*
 TX shape:
 {
   id, date (YYYY-MM-DD), time (HH:MM), amount (always positive number),
   type: 'income'|'expense'|'transfer'|'lend'|'borrow'|'repay_received'|'repay_paid'|'refund'|'bill'|'subscription'|'adjustment',
   category, subcategory,
   accountId,            // primary account affected
   toAccountId,          // for transfers
   personId,             // for lend/borrow/repay
   merchant, note, tags: [],
   paymentMethod,
   needWant: 'need'|'want'|null,
   recurringId,
   splitGroupId,         // links a bill-split's generated lend transactions
   envelopeId,           // links this transaction to a Budget Envelope (see Envelopes section below)
   envelopeKind: 'expense'|'addition', // only set when envelopeId is set — which side of the envelope ledger this is
   paymentMethod, receipt, // receipt: {name, dataUrl} — small optional image/file reference
   createdAt, updatedAt
 }
*/

class Store {
  constructor() {
    this.state = this._load();
    this._listeners = [];
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return DEFAULT_STATE();
      const parsed = JSON.parse(raw);
      // shallow-merge to survive schema additions across versions
      return Object.assign(DEFAULT_STATE(), parsed, {
        profile: Object.assign(DEFAULT_STATE().profile, parsed.profile || {}),
        settings: Object.assign(DEFAULT_STATE().settings, parsed.settings || {})
      });
    } catch (e) {
      console.warn('MYBILL: could not parse saved data, starting fresh.', e);
      return DEFAULT_STATE();
    }
  }

  save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    this._emit();
    if (window.MyBillDrive && window.MyBillDrive.isConnected()) {
      window.MyBillDrive.queueSync(this.state);
    }
  }

  onChange(fn) { this._listeners.push(fn); }
  _emit() { this._listeners.forEach(fn => { try { fn(this.state); } catch (e) { console.error(e); } }); }

  /* ---------------- Accounts ---------------- */
  addAccount({ name, type, openingBalance = 0 }) {
    const acc = { id: uid(), name, type, openingBalance: Number(openingBalance) || 0, active: true, createdAt: nowISO() };
    this.state.accounts.push(acc);
    this.save();
    return acc;
  }
  updateAccount(id, patch) {
    const acc = this.state.accounts.find(a => a.id === id);
    if (!acc) return;
    Object.assign(acc, patch);
    this.save();
  }
  deleteAccount(id) {
    this.state.accounts = this.state.accounts.filter(a => a.id !== id);
    this.save();
  }
  accountBalance(id) {
    const acc = this.state.accounts.find(a => a.id === id);
    if (!acc) return 0;
    let bal = acc.openingBalance;
    for (const t of this.state.transactions) {
      if (t.accountId === id) {
        if (['income', 'repay_received', 'refund', 'borrow'].includes(t.type)) bal += t.amount;
        else if (['expense', 'lend', 'repay_paid', 'bill', 'subscription'].includes(t.type)) bal -= t.amount;
        else if (t.type === 'transfer') bal -= t.amount;
        else if (t.type === 'adjustment') bal += t.amount;
      }
      if (t.type === 'transfer' && t.toAccountId === id) bal += t.amount;
    }
    return bal;
  }
  totalBalance() {
    return this.state.accounts.reduce((sum, a) => sum + this.accountBalance(a.id), 0);
  }
  balancesByType() {
    const groups = {};
    for (const a of this.state.accounts) {
      const key = a.type || 'Other';
      groups[key] = (groups[key] || 0) + this.accountBalance(a.id);
    }
    return groups;
  }

  /* ---------------- People / Lending ---------------- */
  addPerson(name, note = '') {
    const p = { id: uid(), name, note, createdAt: nowISO() };
    this.state.people.push(p);
    this.save();
    return p;
  }
  deletePerson(id) {
    this.state.people = this.state.people.filter(p => p.id !== id);
    this.save();
  }
  personBalance(personId) {
    // positive = they owe you; negative = you owe them
    let bal = 0;
    for (const t of this.state.transactions) {
      if (t.personId !== personId) continue;
      if (t.type === 'lend') bal += t.amount;
      if (t.type === 'repay_received') bal -= t.amount;
      if (t.type === 'borrow') bal -= t.amount;
      if (t.type === 'repay_paid') bal += t.amount;
    }
    return bal;
  }
  personLedger(personId) {
    return this.state.transactions
      .filter(t => t.personId === personId)
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  }
  totalReceivable() {
    return this.state.people.reduce((s, p) => s + Math.max(0, this.personBalance(p.id)), 0);
  }
  totalPayable() {
    return this.state.people.reduce((s, p) => s + Math.max(0, -this.personBalance(p.id)), 0);
  }

  /* ---------------- Transactions ---------------- */
  addTransaction(tx) {
    const record = Object.assign({
      id: uid(), date: todayISO(), time: '12:00', tags: [],
      needWant: null, createdAt: nowISO(), updatedAt: nowISO()
    }, tx);
    record.amount = Math.abs(Number(record.amount) || 0);
    this.state.transactions.push(record);
    this._maybeCreateGoalContribution(record);
    this.save();
    return record;
  }
  updateTransaction(id, patch) {
    const t = this.state.transactions.find(t => t.id === id);
    if (!t) return null;
    Object.assign(t, patch, { updatedAt: nowISO() });
    if (patch.amount != null) t.amount = Math.abs(Number(patch.amount) || 0);
    this.save();
    return t;
  }
  deleteTransaction(id) {
    const idx = this.state.transactions.findIndex(t => t.id === id);
    if (idx === -1) return null;
    const [removed] = this.state.transactions.splice(idx, 1);
    this.save();
    return removed;
  }
  restoreTransaction(tx) {
    this.state.transactions.push(tx);
    this.save();
  }

  /* Bill splitting: creates one expense (payer) + lend transactions for each other participant */
  splitBill({ title, totalAmount, date, accountId, participants, paidByMe = true }) {
    // participants: [{personId|null (null = "You"), amount}]
    const groupId = uid();
    const created = [];
    if (paidByMe) {
      created.push(this.addTransaction({
        type: 'expense', amount: totalAmount, category: 'Personal', subcategory: 'Shopping',
        merchant: title, note: `Split bill: ${title}`, accountId, date, splitGroupId: groupId
      }));
      for (const p of participants) {
        if (!p.personId) continue; // "you" share is already covered by the expense above
        created.push(this.addTransaction({
          type: 'lend', amount: p.amount, category: 'Split', personId: p.personId,
          note: `Their share of "${title}"`, accountId, date, splitGroupId: groupId
        }));
      }
    }
    return created;
  }

  /* ---------------- Budgets ---------------- */
  setBudget(category, monthlyAmount) {
    let b = this.state.budgets.find(b => b.category === category);
    if (!b) { b = { id: uid(), category, monthlyAmount }; this.state.budgets.push(b); }
    else b.monthlyAmount = monthlyAmount;
    this.save();
    return b;
  }
  deleteBudget(id) { this.state.budgets = this.state.budgets.filter(b => b.id !== id); this.save(); }
  budgetStatus(monthKey = currentMonthKey()) {
    return this.state.budgets.map(b => {
      const spent = this.state.transactions
        .filter(t => t.type === 'expense' && t.category === b.category && t.date.startsWith(monthKey))
        .reduce((s, t) => s + t.amount, 0);
      return {
        ...b, spent, remaining: b.monthlyAmount - spent,
        pct: b.monthlyAmount > 0 ? Math.min(999, Math.round((spent / b.monthlyAmount) * 100)) : 0
      };
    });
  }

  /* ---------------- Budget Envelopes (budget-as-account) ----------------
   * A budget here is a self-contained pot of money (e.g. "Travel",
   * "Personal Savings") with its own initial amount, its own running
   * balance, and its own transaction history. This is layered on top of
   * the SAME transaction list used everywhere else in the app — every
   * "add expense" / "add money" inside an envelope creates a normal
   * transaction record with envelopeId + envelopeKind set, so nothing
   * bypasses the existing calculation/export/Drive-sync pipeline, and
   * nothing is ever a manually-edited standalone balance.
   */
  addEnvelope({ name, initialAmount = 0, category = 'General', description = '', startDate, endDate, color, notes }) {
    if (!name || !String(name).trim()) throw new Error('Budget name is required');
    const env = {
      id: uid(), name: String(name).trim(), initialAmount: Math.abs(Number(initialAmount)) || 0,
      category, description: description || '', startDate: startDate || todayISO(), endDate: endDate || null,
      color: color || null, notes: notes || '', createdAt: nowISO(), updatedAt: nowISO()
    };
    this.state.envelopes.push(env);
    this.save();
    return env;
  }
  updateEnvelope(id, patch) {
    const env = this.state.envelopes.find(e => e.id === id);
    if (!env) return null;
    if (patch.initialAmount != null) patch.initialAmount = Math.abs(Number(patch.initialAmount)) || 0;
    Object.assign(env, patch, { updatedAt: nowISO() });
    this.save();
    return env;
  }
  // Deletes the envelope AND every transaction tied to it (explicit, irreversible — UI must confirm first)
  deleteEnvelope(id) {
    const removedTx = this.state.transactions.filter(t => t.envelopeId === id);
    this.state.transactions = this.state.transactions.filter(t => t.envelopeId !== id);
    this.state.envelopes = this.state.envelopes.filter(e => e.id !== id);
    this.save();
    return removedTx;
  }
  envelopeTransactions(id) {
    return this.state.transactions
      .filter(t => t.envelopeId === id)
      .sort((a, b) => (a.date + (a.time || '') + a.createdAt).localeCompare(b.date + (b.time || '') + b.createdAt));
  }
  // Adds a real transaction scoped to this envelope. kind: 'expense' | 'addition'
  addEnvelopeTransaction(envelopeId, kind, payload) {
    const env = this.state.envelopes.find(e => e.id === envelopeId);
    if (!env) throw new Error('Budget not found');
    const amount = Math.abs(Number(payload.amount));
    if (!amount || isNaN(amount)) throw new Error('Enter a valid amount');
    return this.addTransaction({
      type: kind === 'addition' ? 'income' : 'expense',
      amount,
      date: payload.date || todayISO(),
      time: payload.time || new Date().toTimeString().slice(0, 5),
      category: kind === 'addition' ? 'Money Added' : (payload.category || 'Other'),
      merchant: payload.title || (kind === 'addition' ? 'Money Added' : 'Expense'),
      note: payload.description || '',
      paymentMethod: payload.paymentMethod || '',
      notes: payload.notes || '',
      receipt: payload.receipt || null,
      accountId: payload.accountId || undefined,
      needWant: payload.needWant || null,
      envelopeId, envelopeKind: kind
    });
  }
  // Stats for a single envelope — always derived, never a stored/editable balance
  envelopeStats(id) {
    const env = this.state.envelopes.find(e => e.id === id);
    if (!env) return null;
    const txs = this.envelopeTransactions(id);
    const totalAdded = txs.filter(t => t.envelopeKind === 'addition').reduce((s, t) => s + t.amount, 0);
    const totalSpent = txs.filter(t => t.envelopeKind === 'expense').reduce((s, t) => s + t.amount, 0);
    const totalAvailable = env.initialAmount + totalAdded;
    const balance = totalAvailable - totalSpent;
    const pct = totalAvailable > 0 ? Math.round((totalSpent / totalAvailable) * 1000) / 10 : 0;
    let status = 'Active';
    if (balance < 0) status = 'Over Budget';
    else if (env.endDate && env.endDate < todayISO()) status = 'Completed';
    return {
      envelope: env, totalAdded, totalSpent, totalAvailable, balance, pct,
      txCount: txs.length, status
    };
  }
  // Running balance alongside each transaction, in chronological order
  envelopeTransactionsWithRunningBalance(id) {
    const env = this.state.envelopes.find(e => e.id === id);
    if (!env) return [];
    let running = env.initialAmount;
    return this.envelopeTransactions(id).map(t => {
      running += t.envelopeKind === 'addition' ? t.amount : -t.amount;
      return { ...t, runningBalance: running };
    });
  }
  allEnvelopeStats() { return this.state.envelopes.map(e => this.envelopeStats(e.id)); }
  envelopeDashboardTotals() {
    const all = this.allEnvelopeStats();
    return {
      totalFunds: all.reduce((s, e) => s + e.envelope.initialAmount, 0),
      totalAdded: all.reduce((s, e) => s + e.totalAdded, 0),
      totalSpent: all.reduce((s, e) => s + e.totalSpent, 0),
      totalRemaining: all.reduce((s, e) => s + e.balance, 0),
      count: all.length,
      txCount: all.reduce((s, e) => s + e.txCount, 0)
    };
  }
  filterEnvelopeTransactions(envelopeId, filters = {}) {
    let list = this.envelopeTransactionsWithRunningBalance(envelopeId);
    if (filters.query) {
      const q = filters.query.trim().toLowerCase();
      list = list.filter(t => [t.merchant, t.note, t.category, t.notes].filter(Boolean).join(' ').toLowerCase().includes(q));
    }
    if (filters.kind) list = list.filter(t => t.envelopeKind === filters.kind);
    if (filters.category) list = list.filter(t => t.category === filters.category);
    if (filters.paymentMethod) list = list.filter(t => t.paymentMethod === filters.paymentMethod);
    if (filters.dateFrom) list = list.filter(t => t.date >= filters.dateFrom);
    if (filters.dateTo) list = list.filter(t => t.date <= filters.dateTo);
    if (filters.minAmount != null) list = list.filter(t => t.amount >= filters.minAmount);
    if (filters.maxAmount != null) list = list.filter(t => t.amount <= filters.maxAmount);
    return list.slice().reverse(); // newest first for display
  }
  searchEnvelopes(query) {
    const q = (query || '').trim().toLowerCase();
    let list = this.allEnvelopeStats();
    if (q) list = list.filter(e => [e.envelope.name, e.envelope.category, e.envelope.description].filter(Boolean).join(' ').toLowerCase().includes(q));
    return list;
  }
  sortEnvelopeStats(list, sortBy) {
    const arr = list.slice();
    if (sortBy === 'highest_spend') arr.sort((a, b) => b.totalSpent - a.totalSpent);
    else if (sortBy === 'lowest_spend') arr.sort((a, b) => a.totalSpent - b.totalSpent);
    else if (sortBy === 'name') arr.sort((a, b) => a.envelope.name.localeCompare(b.envelope.name));
    else if (sortBy === 'recent') arr.sort((a, b) => b.envelope.createdAt.localeCompare(a.envelope.createdAt));
    else if (sortBy === 'active') arr.sort((a, b) => (a.status === 'Active' ? -1 : 1) - (b.status === 'Active' ? -1 : 1));
    return arr;
  }
  // One-time, non-destructive migration: only ever ADDS a fallback envelope,
  // never touches or deletes any existing data. Called lazily by the UI.
  ensureUncategorizedEnvelope() {
    let env = this.state.envelopes.find(e => e.name === 'General / Uncategorized');
    if (!env) env = this.addEnvelope({ name: 'General / Uncategorized', initialAmount: 0, category: 'Other', description: 'Auto-created holder for expenses not assigned to a specific budget.' });
    return env;
  }

  /* ---------------- Goals ---------------- */
  addGoal({ name, target, deadline, monthlyContribution = 0 }) {
    const g = { id: uid(), name, target: Number(target), saved: 0, deadline, monthlyContribution: Number(monthlyContribution) || 0, createdAt: nowISO() };
    this.state.goals.push(g);
    this.save();
    return g;
  }
  contributeToGoal(id, amount) {
    const g = this.state.goals.find(g => g.id === id);
    if (!g) return;
    g.saved += Number(amount);
    this.save();
  }
  deleteGoal(id) { this.state.goals = this.state.goals.filter(g => g.id !== id); this.save(); }
  _maybeCreateGoalContribution() { /* hook reserved for future auto-round-up rules */ }
  goalProjection(g) {
    if (g.monthlyContribution <= 0) return null;
    const monthsNeeded = Math.ceil((g.target - g.saved) / g.monthlyContribution);
    const d = new Date();
    d.setMonth(d.getMonth() + Math.max(0, monthsNeeded));
    return { monthsNeeded: Math.max(0, monthsNeeded), estCompletion: d.toISOString().slice(0, 10) };
  }

  /* ---------------- Recurring / Subscriptions ---------------- */
  addRecurring(r) {
    const rec = Object.assign({ id: uid(), active: true, createdAt: nowISO() }, r);
    this.state.recurring.push(rec);
    this.save();
    return rec;
  }
  updateRecurring(id, patch) {
    const r = this.state.recurring.find(r => r.id === id);
    if (!r) return;
    Object.assign(r, patch);
    this.save();
  }
  deleteRecurring(id) { this.state.recurring = this.state.recurring.filter(r => r.id !== id); this.save(); }
  markRecurringPaid(id) {
    const r = this.state.recurring.find(r => r.id === id);
    if (!r) return;
    this.addTransaction({
      type: r.kind === 'subscription' ? 'subscription' : (r.kind === 'bill' ? 'bill' : 'expense'),
      amount: r.amount, category: r.category, accountId: r.account, merchant: r.name,
      note: `Recurring: ${r.name}`, recurringId: r.id
    });
    r.nextDate = advanceDate(r.nextDate, r.frequency);
    this.save();
  }
  upcomingRecurring(daysAhead = 14) {
    const today = new Date();
    const limit = new Date(); limit.setDate(limit.getDate() + daysAhead);
    return this.state.recurring.filter(r => r.active && new Date(r.nextDate) <= limit)
      .sort((a, b) => a.nextDate.localeCompare(b.nextDate));
  }
  overdueRecurring() {
    const todayStr = todayISO();
    return this.state.recurring.filter(r => r.active && r.nextDate < todayStr);
  }
  subscriptionAnnualCost() {
    const cycles = { daily: 365, weekly: 52, monthly: 12, yearly: 1 };
    return this.state.recurring.filter(r => r.kind === 'subscription' && r.active)
      .reduce((s, r) => s + r.amount * (cycles[r.frequency] || 12), 0);
  }

  /* ---------------- Derived analytics ---------------- */
  monthTransactions(monthKey = currentMonthKey()) {
    return this.state.transactions.filter(t => t.date.startsWith(monthKey));
  }
  monthIncome(monthKey = currentMonthKey()) {
    return this.monthTransactions(monthKey).filter(t => ['income', 'refund', 'repay_received'].includes(t.type)).reduce((s, t) => s + t.amount, 0);
  }
  monthExpense(monthKey = currentMonthKey()) {
    return this.monthTransactions(monthKey).filter(t => ['expense', 'bill', 'subscription'].includes(t.type)).reduce((s, t) => s + t.amount, 0);
  }
  todaySpend() {
    const today = todayISO();
    return this.state.transactions.filter(t => t.date === today && ['expense', 'bill', 'subscription'].includes(t.type)).reduce((s, t) => s + t.amount, 0);
  }
  categoryBreakdown(monthKey = currentMonthKey()) {
    const map = {};
    for (const t of this.monthTransactions(monthKey)) {
      if (!['expense', 'bill', 'subscription'].includes(t.type)) continue;
      map[t.category] = (map[t.category] || 0) + t.amount;
    }
    return map;
  }
  needWantBreakdown(monthKey = currentMonthKey()) {
    let need = 0, want = 0, unclassified = 0;
    for (const t of this.monthTransactions(monthKey)) {
      if (t.type !== 'expense') continue;
      if (t.needWant === 'need') need += t.amount;
      else if (t.needWant === 'want') want += t.amount;
      else unclassified += t.amount;
    }
    return { need, want, unclassified };
  }
  dailySpendSeries(days = 14) {
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const total = this.state.transactions.filter(t => t.date === key && ['expense', 'bill', 'subscription'].includes(t.type)).reduce((s, t) => s + t.amount, 0);
      out.push({ date: key, total });
    }
    return out;
  }
  monthlyTrend(months = 6) {
    const out = [];
    const d = new Date();
    for (let i = months - 1; i >= 0; i--) {
      const dd = new Date(d.getFullYear(), d.getMonth() - i, 1);
      const key = dd.toISOString().slice(0, 7);
      out.push({ month: key, income: this.monthIncome(key), expense: this.monthExpense(key) });
    }
    return out;
  }
  daysRemainingInMonth() {
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return end.getDate() - now.getDate();
  }
  safeToSpend() {
    const balance = this.totalBalance();
    const receivable = this.totalReceivable();
    const payable = this.totalPayable();
    const upcoming = this.upcomingRecurring(this.daysRemainingInMonth() || 1).reduce((s, r) => s + r.amount, 0);
    const savingsTarget = this.state.profile.savingsMonthlyTarget || 0;
    const safeBalance = balance + receivable - payable - upcoming - savingsTarget;
    const days = Math.max(1, this.daysRemainingInMonth());
    return {
      balance, receivable, payable, upcoming, savingsTarget,
      safeBalance: Math.max(0, safeBalance),
      perDay: Math.max(0, safeBalance / days),
      days
    };
  }
  cashFlowForecast() {
    const monthKey = currentMonthKey();
    const balance = this.totalBalance();
    const avgDailyExpense = (() => {
      const series = this.dailySpendSeries(14);
      const sum = series.reduce((s, d) => s + d.total, 0);
      return sum / 14;
    })();
    const remainingUpcoming = this.upcomingRecurring(this.daysRemainingInMonth()).reduce((s, r) => s + r.amount, 0);
    const projectedExpense = avgDailyExpense * this.daysRemainingInMonth() + remainingUpcoming;
    const expectedIncome = 0; // no reliable predictor without recurring income marked; conservative default
    return {
      currentBalance: balance,
      projectedExpense: Math.round(projectedExpense),
      expectedIncome,
      predictedMonthEnd: Math.round(balance + expectedIncome - projectedExpense)
    };
  }
  financialHealthScore() {
    const income = this.monthIncome() || 1;
    const expense = this.monthExpense();
    const savingsRate = Math.max(-1, Math.min(1, (income - expense) / income));
    const budgets = this.budgetStatus();
    const budgetAdherence = budgets.length ? budgets.filter(b => b.pct <= 100).length / budgets.length : 0.7;
    const payable = this.totalPayable();
    const debtFactor = payable > 0 ? Math.max(0, 1 - payable / (income || 1)) : 1;
    const goalProgress = this.state.goals.length
      ? this.state.goals.reduce((s, g) => s + Math.min(1, g.saved / (g.target || 1)), 0) / this.state.goals.length
      : 0.5;
    const parts = {
      savingsRate: Math.round(savingsRate * 100),
      budgetAdherence: Math.round(budgetAdherence * 100),
      debtFactor: Math.round(debtFactor * 100),
      goalProgress: Math.round(goalProgress * 100)
    };
    const score = Math.round(
      Math.max(0, Math.min(100, 50 + savingsRate * 30)) * 0.35 +
      budgetAdherence * 100 * 0.25 +
      debtFactor * 100 * 0.25 +
      goalProgress * 100 * 0.15
    );
    return { score: Math.max(0, Math.min(100, score)), parts };
  }

  /* ---------------- Search & filter ---------------- */
  search(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return this.state.transactions.filter(t => {
      const person = this.state.people.find(p => p.id === t.personId);
      const hay = [t.category, t.subcategory, t.merchant, t.note, t.date, String(t.amount), person && person.name, ...(t.tags || [])]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }
  filterTransactions(filters) {
    return this.state.transactions.filter(t => {
      if (filters.dateFrom && t.date < filters.dateFrom) return false;
      if (filters.dateTo && t.date > filters.dateTo) return false;
      if (filters.category && t.category !== filters.category) return false;
      if (filters.accountId && t.accountId !== filters.accountId) return false;
      if (filters.personId && t.personId !== filters.personId) return false;
      if (filters.type && t.type !== filters.type) return false;
      if (filters.needWant && t.needWant !== filters.needWant) return false;
      if (filters.minAmount != null && t.amount < filters.minAmount) return false;
      if (filters.maxAmount != null && t.amount > filters.maxAmount) return false;
      return true;
    }).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  }

  /* ---------------- Export / import / backup ---------------- */
  exportJSON() {
    return JSON.stringify(this.state, null, 2);
  }
  exportCSV(transactions = this.state.transactions) {
    const headers = ['date', 'time', 'type', 'amount', 'category', 'subcategory', 'account', 'person', 'budget', 'merchant', 'note', 'needWant'];
    const rows = transactions.map(t => {
      const acc = this.state.accounts.find(a => a.id === t.accountId);
      const person = this.state.people.find(p => p.id === t.personId);
      const env = this.state.envelopes.find(e => e.id === t.envelopeId);
      return [t.date, t.time, t.type, t.amount, t.category || '', t.subcategory || '', acc ? acc.name : '', person ? person.name : '', env ? env.name : '', t.merchant || '', (t.note || '').replace(/,/g, ';'), t.needWant || ''];
    });
    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }
  importJSON(jsonString) {
    const parsed = JSON.parse(jsonString);
    this.state = Object.assign(DEFAULT_STATE(), parsed);
    this.save();
  }
  resetAll() {
    this.state = DEFAULT_STATE();
    this.save();
  }
}

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

function advanceDate(dateStr, frequency) {
  const d = new Date(dateStr);
  if (frequency === 'daily') d.setDate(d.getDate() + 1);
  else if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  else if (frequency === 'monthly') d.setMonth(d.getMonth() + 1);
  else if (frequency === 'yearly') d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

window.MyBillStore = new Store();
window.MyBillHelpers = { uid, todayISO, nowISO, currentMonthKey, advanceDate, INCOME_SOURCES };

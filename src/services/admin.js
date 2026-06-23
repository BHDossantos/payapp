import { HttpError } from '../lib/http.js';
import { toEuros } from '../lib/validate.js';
import { publicUser, walletFor } from './accounts.js';
import { publicMerchant } from './business.js';
import { publicTransaction } from './payments.js';

// AML thresholds (configurable). A single transfer at/above the large-amount
// threshold, or a burst of sends in a short window, raises an alert.
const LARGE_AMOUNT_CENTS = Math.round(Number(process.env.EUROFLOW_AML_LARGE_EUR || 1000) * 100);
const VELOCITY_COUNT = Number(process.env.EUROFLOW_AML_VELOCITY_COUNT || 5);
const VELOCITY_WINDOW_MS = Number(process.env.EUROFLOW_AML_VELOCITY_WINDOW_MS || 60_000);

// Enriches a user with their wallet balance and merchant status for admin views.
function adminUser(store, user) {
  const wallet = walletFor(store, user.id);
  const merchant = store.find('merchants', (m) => m.userId === user.id);
  return {
    ...publicUser(user),
    balance: wallet ? toEuros(wallet.balanceCents) : null,
    merchant_status: merchant ? merchant.status : null,
  };
}

export function listUsers(store) {
  return store
    .all('users')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((u) => adminUser(store, u));
}

export function listTransactions(store, query = {}) {
  let txs = store.all('transactions');
  if (query.status) txs = txs.filter((t) => t.status === query.status);
  if (query.type) txs = txs.filter((t) => t.type === query.type);
  txs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return txs.map((t) => publicTransaction(store, t));
}

export function listMerchants(store, query = {}) {
  let merchants = store.all('merchants');
  if (query.status) merchants = merchants.filter((m) => m.status === query.status);
  merchants.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return merchants.map(publicMerchant);
}

const MERCHANT_TRANSITIONS = {
  approve: 'active',
  reject: 'rejected',
  suspend: 'suspended',
};

export function setMerchantStatus(store, merchantId, action) {
  const status = MERCHANT_TRANSITIONS[action];
  if (!status) throw new HttpError(400, `Unknown merchant action "${action}"`);
  const merchant = store.get('merchants', merchantId);
  if (!merchant) throw new HttpError(404, 'Merchant not found');
  store.update('merchants', merchantId, { status });
  return publicMerchant(store.get('merchants', merchantId));
}

const KYC_STATUSES = new Set(['verified', 'rejected', 'unverified']);

export function setKycStatus(store, userId, status) {
  if (!KYC_STATUSES.has(status)) {
    throw new HttpError(400, `kyc status must be one of: ${[...KYC_STATUSES].join(', ')}`);
  }
  const user = store.get('users', userId);
  if (!user) throw new HttpError(404, 'User not found');
  store.update('users', userId, { kycStatus: status });
  return adminUser(store, store.get('users', userId));
}

// Derives AML/risk alerts from the transaction ledger. Pure read — no state is
// stored, so alerts always reflect current data and configured thresholds.
export function amlAlerts(store) {
  const alerts = [];
  const completed = store
    .all('transactions')
    .filter((t) => t.status === 'completed')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // 1) Large single transfers.
  for (const t of completed) {
    if (t.amountCents >= LARGE_AMOUNT_CENTS) {
      alerts.push({
        type: 'large_transfer',
        severity: 'high',
        user_id: t.senderUserId,
        transaction_id: t.id,
        amount: toEuros(t.amountCents),
        detail: `Transfer of ${toEuros(t.amountCents)} EUR at/above the ${toEuros(LARGE_AMOUNT_CENTS)} threshold`,
      });
    }
  }

  // 2) High send velocity per sender within a sliding window.
  const bySender = new Map();
  for (const t of completed) {
    if (!bySender.has(t.senderUserId)) bySender.set(t.senderUserId, []);
    bySender.get(t.senderUserId).push(t);
  }
  for (const [senderId, txs] of bySender) {
    for (let i = 0; i + VELOCITY_COUNT - 1 < txs.length; i++) {
      const first = Date.parse(txs[i].createdAt);
      const last = Date.parse(txs[i + VELOCITY_COUNT - 1].createdAt);
      if (last - first <= VELOCITY_WINDOW_MS) {
        alerts.push({
          type: 'high_velocity',
          severity: 'medium',
          user_id: senderId,
          detail: `${VELOCITY_COUNT} transfers within ${Math.round(VELOCITY_WINDOW_MS / 1000)}s`,
        });
        break; // one velocity alert per sender is enough
      }
    }
  }
  return alerts;
}

// Risk/compliance dashboard summary.
export function stats(store) {
  const users = store.all('users');
  const txs = store.all('transactions');
  const merchants = store.all('merchants');
  const completed = txs.filter((t) => t.status === 'completed');
  const countBy = (items, key) => items.reduce((acc, it) => {
    acc[it[key]] = (acc[it[key]] || 0) + 1;
    return acc;
  }, {});

  return {
    users: {
      total: users.length,
      by_kyc: countBy(users, 'kycStatus'),
      admins: users.filter((u) => u.isAdmin).length,
    },
    merchants: {
      total: merchants.length,
      by_status: countBy(merchants, 'status'),
    },
    transactions: {
      total: txs.length,
      by_status: countBy(txs, 'status'),
      volume_completed: toEuros(completed.reduce((sum, t) => sum + t.amountCents, 0)),
    },
    aml: {
      open_alerts: amlAlerts(store).length,
    },
  };
}

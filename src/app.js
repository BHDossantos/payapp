import { URL } from 'node:url';
import { Router, HttpError, sendJson, readJsonBody } from './lib/http.js';
import { verifyToken } from './lib/crypto.js';
import { serveStatic } from './lib/static.js';
import * as accounts from './services/accounts.js';
import * as payments from './services/payments.js';
import * as requests from './services/requests.js';
import * as splits from './services/splits.js';
import * as business from './services/business.js';
import * as admin from './services/admin.js';
import * as notifications from './services/notifications.js';

// Routes flagged `auth: true` require a valid Bearer token; the resolved user
// id is passed to the handler as `ctx.userId`.
function buildRouter() {
  const r = new Router();

  // --- health ---
  r.get('/health', () => ({ status: 200, body: { ok: true, service: 'euroflow', time: new Date().toISOString() } }));

  // --- auth ---
  r.post('/auth/register', ({ store, body }) => ({ status: 201, body: accounts.register(store, body) }));
  r.post('/auth/login', ({ store, body }) => ({ status: 200, body: accounts.login(store, body) }));

  // --- profile / wallet ---
  r.get('/me', { auth: true }, ({ store, userId }) => ({
    status: 200,
    body: {
      user: accounts.publicUser(store.get('users', userId)),
      wallet: accounts.publicWallet(accounts.walletFor(store, userId)),
    },
  }));
  r.get('/wallet', { auth: true }, ({ store, userId }) => ({
    status: 200,
    body: accounts.publicWallet(accounts.walletFor(store, userId)),
  }));
  r.post('/wallet/topup', { auth: true }, ({ store, userId, body }) => {
    const cents = Math.round((body.amount || 0) * 100);
    if (cents <= 0) throw new HttpError(400, 'amount must be a positive number of euros');
    return { status: 200, body: accounts.topUp(store, userId, cents) };
  });

  // --- payments ---
  r.post('/wallet/send', { auth: true }, ({ store, userId, body }) => ({
    status: 201, body: payments.sendMoney(store, userId, body),
  }));
  r.get('/wallet/history', { auth: true }, ({ store, userId, query }) => ({
    status: 200, body: { transactions: payments.history(store, userId, query) },
  }));
  r.get('/transactions', { auth: true }, ({ store, userId, query }) => ({
    status: 200, body: { transactions: payments.history(store, userId, query) },
  }));

  // --- requests ---
  r.post('/wallet/request', { auth: true }, ({ store, userId, body }) => ({
    status: 201, body: requests.createRequest(store, userId, body),
  }));
  r.get('/wallet/requests', { auth: true }, ({ store, userId, query }) => ({
    status: 200, body: { requests: requests.listRequests(store, userId, query.box) },
  }));
  r.post('/wallet/requests/:id/pay', { auth: true }, ({ store, userId, params }) => ({
    status: 200, body: requests.payRequest(store, userId, params.id),
  }));
  r.post('/wallet/requests/:id/decline', { auth: true }, ({ store, userId, params }) => ({
    status: 200, body: requests.declineRequest(store, userId, params.id),
  }));

  // --- splits ---
  r.post('/wallet/split', { auth: true }, ({ store, userId, body }) => ({
    status: 201, body: splits.createSplit(store, userId, body),
  }));
  r.get('/splits', { auth: true }, ({ store, userId }) => ({
    status: 200, body: { splits: splits.listSplits(store, userId) },
  }));
  r.get('/splits/:id', { auth: true }, ({ store, params }) => ({
    status: 200, body: splits.getSplit(store, params.id),
  }));
  r.post('/splits/:id/pay', { auth: true }, ({ store, userId, params }) => ({
    status: 200, body: splits.paySplitShare(store, userId, params.id),
  }));

  // --- merchant / business ---
  r.post('/merchant/register', { auth: true }, ({ store, userId, body }) => ({
    status: 201, body: business.registerMerchant(store, userId, body),
  }));
  r.get('/merchant', { auth: true }, ({ store, userId }) => ({
    status: 200, body: business.getMyMerchant(store, userId),
  }));
  r.post('/invoice/create', { auth: true }, ({ store, userId, body }) => ({
    status: 201, body: business.createInvoice(store, userId, body),
  }));
  r.get('/invoices', { auth: true }, ({ store, userId }) => ({
    status: 200, body: { invoices: business.listInvoices(store, userId) },
  }));
  r.post('/invoices/:id/paid', { auth: true }, ({ store, userId, params }) => ({
    status: 200, body: business.markInvoicePaid(store, userId, params.id),
  }));

  // --- qr ---
  r.post('/qr/generate', { auth: true }, ({ store, userId, body }) => ({
    status: 201, body: business.generateQr(store, userId, body),
  }));

  // --- notifications ---
  r.get('/notifications', { auth: true }, ({ store, userId, query }) => ({
    status: 200,
    body: {
      notifications: notifications.listNotifications(store, userId, { unread: query.unread === 'true' }),
      unread_count: notifications.unreadCount(store, userId),
    },
  }));
  r.post('/notifications/read-all', { auth: true }, ({ store, userId }) => ({
    status: 200, body: notifications.markAllRead(store, userId),
  }));
  r.post('/notifications/:id/read', { auth: true }, ({ store, userId, params }) => ({
    status: 200, body: notifications.markRead(store, userId, params.id),
  }));

  // --- kyc (stub) ---
  r.post('/kyc/verify', { auth: true }, ({ store, userId }) => ({
    status: 200, body: accounts.verifyKyc(store, userId),
  }));

  // --- admin / compliance ---
  r.get('/admin/stats', { admin: true }, ({ store }) => ({ status: 200, body: admin.stats(store) }));
  r.get('/admin/users', { admin: true }, ({ store }) => ({
    status: 200, body: { users: admin.listUsers(store) },
  }));
  r.get('/admin/transactions', { admin: true }, ({ store, query }) => ({
    status: 200, body: { transactions: admin.listTransactions(store, query) },
  }));
  r.get('/admin/merchants', { admin: true }, ({ store, query }) => ({
    status: 200, body: { merchants: admin.listMerchants(store, query) },
  }));
  r.post('/admin/merchants/:id/:action', { admin: true }, ({ store, params }) => ({
    status: 200, body: admin.setMerchantStatus(store, params.id, params.action),
  }));
  r.post('/admin/users/:id/kyc', { admin: true }, ({ store, params, body }) => ({
    status: 200, body: admin.setKycStatus(store, params.id, body.status),
  }));
  r.get('/admin/aml/alerts', { admin: true }, ({ store }) => ({
    status: 200, body: { alerts: admin.amlAlerts(store) },
  }));

  return r;
}

export function createApp({ store, staticDir = null }) {
  const router = buildRouter();

  return async function handle(req, res) {
    const origin = `http://${req.headers.host || 'localhost'}`;
    const parsed = new URL(req.url, origin);
    const matched = router.match(req.method, parsed.pathname);

    try {
      if (!matched) {
        // No API route: try to serve the web client, otherwise 404 (JSON).
        if (staticDir && await serveStatic(req, res, parsed.pathname, staticDir)) return;
        throw new HttpError(404, 'Not found');
      }

      let userId = null;
      if (matched.opts.auth || matched.opts.admin) {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        const payload = token ? verifyToken(token) : null;
        if (!payload) throw new HttpError(401, 'Missing or invalid authorization token');
        const user = store.get('users', payload.sub);
        if (!user) throw new HttpError(401, 'User no longer exists');
        if (matched.opts.admin && !user.isAdmin) throw new HttpError(403, 'Admin access required');
        userId = payload.sub;
      }

      const body = (req.method === 'POST' || req.method === 'PATCH')
        ? await readJsonBody(req)
        : {};
      const query = Object.fromEntries(parsed.searchParams.entries());

      const result = await matched.handler({ store, userId, body, params: matched.params, query });
      sendJson(res, result.status || 200, result.body);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message, ...(err.details ? { details: err.details } : {}) });
      } else {
        // Unexpected: log server-side, return an opaque 500.
        console.error('Unhandled error:', err);
        sendJson(res, 500, { error: 'Internal server error' });
      }
    }
  };
}

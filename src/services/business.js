import { HttpError } from '../lib/http.js';
import {
  requireString, optionalString, requireAmountCents, normalizeCurrency, toEuros,
} from '../lib/validate.js';
import { walletFor } from './accounts.js';
import { transfer, publicTransaction } from './payments.js';
import { notify } from './notifications.js';

const PAY_BASE_URL = process.env.EUROFLOW_PAY_URL || 'https://euroflow.app/pay';

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export function publicMerchant(merchant) {
  return {
    merchant_id: merchant.id,
    user_id: merchant.userId,
    business_name: merchant.businessName,
    vat_number: merchant.vatNumber,
    country: merchant.country,
    status: merchant.status,
    slug: merchant.slug,
    payment_link: `${PAY_BASE_URL}/${merchant.slug}`,
  };
}

export function registerMerchant(store, userId, body) {
  if (store.find('merchants', (m) => m.userId === userId)) {
    throw new HttpError(409, 'This user already has a merchant profile');
  }
  const businessName = requireString(body, 'business_name', { max: 120 });
  const vatNumber = optionalString(body, 'vat_number', { max: 30 });
  const country = requireString(body, 'country', { min: 2, max: 2 }).toUpperCase();

  let slug = slugify(businessName);
  if (!slug) slug = `m-${Date.now()}`;
  // Ensure slug uniqueness for payment links.
  let candidate = slug;
  let n = 1;
  while (store.find('merchants', (m) => m.slug === candidate)) {
    candidate = `${slug}-${n++}`;
  }

  const merchant = store.insert('merchants', {
    userId,
    businessName,
    vatNumber,
    country,
    status: 'pending', // awaits admin/KYB approval
    slug: candidate,
    createdAt: new Date().toISOString(),
  });
  return publicMerchant(merchant);
}

export function getMyMerchant(store, userId) {
  const merchant = store.find('merchants', (m) => m.userId === userId);
  if (!merchant) throw new HttpError(404, 'No merchant profile for this user');
  return publicMerchant(merchant);
}

export function publicInvoice(invoice) {
  return {
    invoice_id: invoice.id,
    merchant_id: invoice.merchantId,
    customer_name: invoice.customerName,
    amount: toEuros(invoice.amountCents),
    currency: invoice.currency,
    description: invoice.description,
    status: invoice.status,
    due_date: invoice.dueDate,
    paid_at: invoice.paidAt || null,
    pay_link: `${PAY_BASE_URL}/invoice/${invoice.id}`,
    created_at: invoice.createdAt,
  };
}

// Minimal public view of a merchant for a payer at the payment link / QR — no
// internal ids or owner details beyond what's needed to confirm who they pay.
export function getMerchantBySlug(store, slug) {
  const merchant = store.find('merchants', (m) => m.slug === slug);
  if (!merchant) throw new HttpError(404, 'Merchant not found');
  return {
    business_name: merchant.businessName,
    country: merchant.country,
    slug: merchant.slug,
    status: merchant.status,
    accepts_payments: merchant.status !== 'suspended' && merchant.status !== 'rejected',
  };
}

export function createInvoice(store, userId, body) {
  const merchant = store.find('merchants', (m) => m.userId === userId);
  if (!merchant) throw new HttpError(403, 'Register a merchant profile first');
  const customerName = requireString(body, 'customer_name', { max: 120 });
  const amountCents = requireAmountCents(body);
  const description = optionalString(body, 'description', { max: 280 });
  const currency = normalizeCurrency(body);
  const dueDate = optionalString(body, 'due_date', { max: 30 });

  const invoice = store.insert('invoices', {
    merchantId: merchant.id,
    customerName,
    amountCents,
    currency,
    description,
    status: 'open',
    dueDate,
    createdAt: new Date().toISOString(),
  });
  return publicInvoice(invoice);
}

export function listInvoices(store, userId) {
  const merchant = store.find('merchants', (m) => m.userId === userId);
  if (!merchant) throw new HttpError(403, 'Register a merchant profile first');
  return store
    .filter('invoices', (i) => i.merchantId === merchant.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(publicInvoice);
}

export function markInvoicePaid(store, userId, invoiceId) {
  const invoice = store.get('invoices', invoiceId);
  if (!invoice) throw new HttpError(404, 'Invoice not found');
  const merchant = store.get('merchants', invoice.merchantId);
  if (!merchant || merchant.userId !== userId) {
    throw new HttpError(403, 'Only the issuing merchant can update this invoice');
  }
  if (invoice.status === 'paid') throw new HttpError(409, 'Invoice is already paid');
  store.update('invoices', invoiceId, { status: 'paid', paidAt: new Date().toISOString() });
  return publicInvoice(store.get('invoices', invoiceId));
}

// A customer settles an invoice: moves money to the merchant's wallet, marks the
// invoice paid, and notifies the merchant. Distinct from markInvoicePaid, which
// only records an externally-settled invoice without moving money.
export function payInvoice(store, payerUserId, invoiceId) {
  const invoice = store.get('invoices', invoiceId);
  if (!invoice) throw new HttpError(404, 'Invoice not found');
  if (invoice.status === 'paid') throw new HttpError(409, 'Invoice is already paid');
  if (invoice.status === 'void') throw new HttpError(409, 'Invoice is void');
  const merchant = store.get('merchants', invoice.merchantId);
  if (!merchant) throw new HttpError(404, 'Merchant not found');

  const tx = transfer(store, {
    senderUserId: payerUserId,
    receiverUserId: merchant.userId,
    amountCents: invoice.amountCents,
    currency: invoice.currency,
    reference: `Invoice: ${invoice.description || invoice.customerName}`,
    type: 'invoice',
  });
  store.update('invoices', invoiceId, {
    status: 'paid', paidAt: new Date().toISOString(), paidByUserId: payerUserId,
  });

  const payer = store.get('users', payerUserId);
  notify(store, merchant.userId, 'invoice_paid',
    `Invoice paid — €${toEuros(invoice.amountCents).toFixed(2)}`,
    `${payer.firstName} ${payer.lastName} paid “${invoice.description || invoice.customerName}”.`,
    { invoice_id: invoiceId, transaction_id: tx.id, amount: toEuros(invoice.amountCents) });

  return {
    invoice: publicInvoice(store.get('invoices', invoiceId)),
    transaction: publicTransaction(store, tx, payerUserId),
  };
}

// A customer pays a merchant an arbitrary amount via their payment link / QR.
export function payMerchant(store, payerUserId, slug, body) {
  const merchant = store.find('merchants', (m) => m.slug === slug);
  if (!merchant) throw new HttpError(404, 'Merchant not found');
  if (merchant.status === 'suspended' || merchant.status === 'rejected') {
    throw new HttpError(403, 'This merchant is not currently accepting payments');
  }
  const amountCents = requireAmountCents(body);
  const note = optionalString(body, 'note', { max: 140 });
  const payerWallet = walletFor(store, payerUserId);

  const tx = transfer(store, {
    senderUserId: payerUserId,
    receiverUserId: merchant.userId,
    amountCents,
    currency: payerWallet.currency,
    reference: note || `Payment to ${merchant.businessName}`,
    type: 'merchant',
  });

  const payer = store.get('users', payerUserId);
  notify(store, merchant.userId, 'merchant_payment',
    `You received €${toEuros(amountCents).toFixed(2)}`,
    `${payer.firstName} ${payer.lastName} paid ${merchant.businessName}${note ? ` — “${note}”` : ''}.`,
    { transaction_id: tx.id, amount: toEuros(amountCents) });

  return {
    merchant: getMerchantBySlug(store, slug),
    transaction: publicTransaction(store, tx, payerUserId),
  };
}

// Revenue/activity rollup for the merchant's own dashboard.
export function merchantDashboard(store, userId) {
  const merchant = store.find('merchants', (m) => m.userId === userId);
  if (!merchant) throw new HttpError(403, 'Register a merchant profile first');

  const payments = store.filter(
    'transactions',
    (t) => t.receiverUserId === userId
      && t.status === 'completed'
      && (t.type === 'merchant' || t.type === 'invoice'),
  );
  const revenueCents = payments.reduce((sum, t) => sum + t.amountCents, 0);
  const customers = new Set(payments.map((t) => t.senderUserId));

  const invoices = store.filter('invoices', (i) => i.merchantId === merchant.id);
  const openInvoices = invoices.filter((i) => i.status === 'open');
  const outstandingCents = openInvoices.reduce((sum, i) => sum + i.amountCents, 0);

  const recent = payments
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10)
    .map((t) => publicTransaction(store, t, userId));

  return {
    merchant: publicMerchant(merchant),
    revenue: toEuros(revenueCents),
    payments_received: payments.length,
    customers: customers.size,
    invoices: {
      total: invoices.length,
      open: openInvoices.length,
      paid: invoices.filter((i) => i.status === 'paid').length,
      outstanding: toEuros(outstandingCents),
    },
    recent_payments: recent,
  };
}

// Builds a payment QR payload. We emit a `euroflow://pay?...` deep link plus a
// human-facing https link; the client app renders the actual QR bitmap.
export function generateQr(store, userId, body) {
  const type = body.type || 'p2p'; // p2p | merchant | dynamic
  const params = new URLSearchParams();

  if (type === 'merchant' || type === 'dynamic') {
    const merchant = store.find('merchants', (m) => m.userId === userId);
    if (!merchant) throw new HttpError(403, 'Register a merchant profile first');
    params.set('merchant', merchant.slug);
    if (type === 'dynamic') {
      const amountCents = requireAmountCents(body);
      params.set('amount', toEuros(amountCents).toFixed(2));
    }
  } else {
    const user = store.get('users', userId);
    params.set('user', user.username || user.id);
    if (body.amount !== undefined) {
      const amountCents = requireAmountCents(body);
      params.set('amount', toEuros(amountCents).toFixed(2));
    }
  }
  const reference = optionalString(body, 'reference', { max: 80 });
  if (reference) params.set('ref', reference);

  const deepLink = `euroflow://pay?${params.toString()}`;
  const webLink = `${PAY_BASE_URL}?${params.toString()}`;

  const qr = store.insert('qrCodes', {
    userId,
    type,
    payload: deepLink,
    webLink,
    createdAt: new Date().toISOString(),
  });
  return {
    qr_id: qr.id,
    type,
    payload: deepLink,
    web_link: webLink,
    created_at: qr.createdAt,
  };
}

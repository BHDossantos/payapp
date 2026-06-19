import { HttpError } from '../lib/http.js';
import {
  requireString, optionalString, requireAmountCents, normalizeCurrency, toEuros,
} from '../lib/validate.js';
import { walletFor } from './accounts.js';

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
    pay_link: `${PAY_BASE_URL}/invoice/${invoice.id}`,
    created_at: invoice.createdAt,
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
  store.update('invoices', invoiceId, { status: 'paid' });
  return publicInvoice(store.get('invoices', invoiceId));
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

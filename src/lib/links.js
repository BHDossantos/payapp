// Base URL for payment links, invoice links, QR payloads and invites.
//
// The default used to be https://euroflow.app/pay, but that domain is not
// ours: it serves another company's EuroFlow site. Any deployment that forgot
// to set EUROFLOW_PAY_URL would hand customers links to a stranger's domain.
// Default to the local server instead, so a missing setting fails visibly.
export function payBaseUrl() {
  const configured = process.env.EUROFLOW_PAY_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return `http://localhost:${process.env.PORT || 3000}/pay`;
}

// Invite links live next to /pay, e.g. https://example.com/join?ref=ana.
export function joinUrl(ref) {
  const url = new URL('../join', `${payBaseUrl()}/`);
  url.searchParams.set('ref', ref);
  return url.toString();
}

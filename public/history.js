export function filterTransactions(transactions, query = '', direction = '') {
  const term = query.trim().toLocaleLowerCase();
  return transactions.filter(t => (!direction || t.direction === direction) &&
    (!term || [t.sender_name, t.receiver_name, t.reference, t.type, t.status, t.amount]
      .some(value => String(value ?? '').toLocaleLowerCase().includes(term))));
}

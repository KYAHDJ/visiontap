'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChromeEncashmentController, parsePayoutRecords, MIN_CASHOUT_PESOS } = require('../chrome-encashment');

test('payout history columns populate every dashboard detail', () => {
  const result = parsePayoutRecords([{
    headers: ['Requested At', 'Gross Amount', 'Fee / Tax', 'You Receive', 'GCash Account', 'Reference', 'TRX#', 'Status'],
    cells: ['Sep 30, 2026 8:00 AM', '₱426.098', '₱12.783', '₱413.315', '09123455101', 'ECLN-ABC12345', 'TXN-90817263', 'Paid'],
    text: 'Sep 30, 2026 8:00 AM ₱426.098 ₱12.783 ₱413.315 09123455101 ECLN-ABC12345 TXN-90817263 Paid'
  }], '2026-09-30');
  assert.equal(result.amount, '426.098');
  assert.equal(result.tax, '12.783');
  assert.equal(result.netAmount, '413.315');
  assert.equal(result.reference, 'ECLN-ABC12345');
  assert.equal(result.transactionId, 'TXN-90817263');
  assert.equal(result.payoutNumber, '09123455101');
  assert.equal(result.requestedAt, 'Sep 30, 2026 8:00 AM');
  assert.equal(result.status, 'Paid');
});

test('payout parser prefers the requested date over an older row', () => {
  const result = parsePayoutRecords([
    { headers:['Date','Amount','Status'], cells:['Sep 29, 2026','₱100','Paid'], text:'Sep 29, 2026 ₱100 Paid' },
    { headers:['Date','Amount','Status'], cells:['Sep 30, 2026','₱426.098','Pending'], text:'Sep 30, 2026 ₱426.098 Pending' }
  ], '2026-09-30');
  assert.equal(result.amount, '426.098');
  assert.equal(result.status, 'Pending');
});

test('cash-out is hard-locked below 300 pesos', () => {
  assert.equal(MIN_CASHOUT_PESOS, 300);
  assert.match(ChromeEncashmentController.prototype.tick.toString(), /available < MIN_CASHOUT_PESOS/);
  assert.match(ChromeEncashmentController.prototype.attempt.toString(), /available < MIN_CASHOUT_PESOS/);
});

test('submitted payouts receive one final history refresh at or after 9 AM', () => {
  const source = ChromeEncashmentController.prototype.tick.toString();
  assert.match(source, /ph\.hour >= 9/);
  assert.match(source, /!state\.finalHistoryCheckedAt/);
  assert.match(source, /checkHistory\(true\)/);
  assert.match(ChromeEncashmentController.prototype.checkHistory.toString(), /Final 9:00 AM payout history check started/);
});

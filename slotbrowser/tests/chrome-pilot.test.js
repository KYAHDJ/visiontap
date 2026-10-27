const test = require('node:test');
const assert = require('node:assert/strict');
const { ChromePilot, hashImage, isVerificationUrl, ACCOUNT, SLOT_ID, LOGIN_URL, WORK_URL } = require('../chrome-pilot');

test('pilot is locked to the adaihbi account and slot', () => {
  assert.equal(ACCOUNT, 'adaihbi');
  assert.equal(SLOT_ID, '11');
  assert.equal(LOGIN_URL, 'https://ecnlmediamarket.com/login');
  assert.equal(WORK_URL, 'https://ecnlmediamarket.com/solving-colors');
});

test('verification URLs are recognized without matching the normal work page', () => {
  assert.equal(isVerificationUrl('https://ecnlmediamarket.com/solving-colors'), false);
  assert.equal(isVerificationUrl('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x'), true);
  assert.equal(isVerificationUrl('https://ecnlmediamarket.com/cdn-cgi/challenge/x'), true);
});

test('task hashes are stable and distinguish changed images', () => {
  assert.equal(hashImage('data:image/png;base64,abc123'), hashImage('data:image/png;base64,abc123'));
  assert.notEqual(hashImage('data:image/png;base64,abc123'), hashImage('data:image/png;base64,abc124'));
});

test('safe reload is blocked while manual verification is held', async () => {
  const pilot = new ChromePilot({ userDataDir: 'x', executablePath: 'x' });
  let reloads = 0;
  pilot.page = { isClosed: () => false, url: () => 'https://challenges.cloudflare.com/', evaluate: async () => {}, reload: async () => { reloads++; } };
  pilot.verificationHold = true;
  assert.equal(await pilot.safeReload('test'), false);
  assert.equal(reloads, 0);
});

test('persistent stalls escalate after bounded recovery reloads', () => {
  const pilot = new ChromePilot({ userDataDir: 'x', executablePath: 'x' });
  assert.equal(pilot.recoveryReloads, 0);
  const source = pilot.safeReload.toString();
  assert.match(source, /recoveryReloads >= 4/);
  assert.match(source, /lastProgressAt > 60000/);
  assert.match(source, /process\.exitCode = 75/);
});



test('all slots recover server-down and runtime-error pages every 10 seconds', () => {
  const pilot = new ChromePilot({ userDataDir: 'x', executablePath: 'x' });
  assert.match(pilot.detectServerRuntimeError.toString(), /server\\s\+/);
  assert.match(pilot.detectServerRuntimeError.toString(), /runtime error/);
  assert.match(pilot.detectServerRuntimeError.toString(), /application error/);
  assert.match(pilot.guardServerRuntimeError.toString(), /now \+ 10000/);
  assert.match(pilot.guardServerRuntimeError.toString(), /page\.reload/);
  assert.match(pilot.guardServerRuntimeError.toString(), /server is back; continuing the normal work loop/);
  assert.match(pilot.iteration.toString(), /guardServerRuntimeError/);
});

test('pilot loads the shared ad blocker and never disables cleanup', () => {
  const pilot = new ChromePilot({ userDataDir: 'x', executablePath: 'x' });
  assert.match(pilot.adBlockSource, /VisionTap - Minimal Ad Blocker/);
  assert.doesNotMatch(pilot.injectSource, /__vtDisableAdCleanup\s*=\s*true/);
});


test('all eight ECNL accounts have isolated payout controllers', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'chrome-pilot.js'), 'utf8');
  for (const account of ['adaihbi', 'temi', 'axceling1001', 'clarencebopis', 'connormofu', 'jinninijin', 'yaminiko', 'jerrytomaton']) {
    assert.match(source, new RegExp(account));
  }
});

test('ECNL submission delays are staggered across the eight accounts', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'chrome-pilot.js'), 'utf8');
  assert.match(source, /adaihbi: 0/);
  assert.match(source, /temi: 300/);
  assert.match(source, /axceling1001: 600/);
  assert.match(source, /clarencebopis: 900/);
  assert.match(source, /connormofu: 1100/);
  assert.match(source, /jinninijin: 450/);
  assert.match(source, /yaminiko: 750/);
  assert.match(source, /jerrytomaton: 1050/);
});


test('ECNL checking state reloads only after a genuine 30-second stall', () => {
  const pilot = new ChromePilot({ userDataDir: 'x', executablePath: 'x' });
  const source = pilot.iteration.toString();
  assert.match(source, /ECNL_CHECKING_STALL_MS/);
  assert.match(source, /ECNL checking state stalled for 30 seconds/);
});

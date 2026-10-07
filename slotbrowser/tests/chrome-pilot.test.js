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

test('PMath restores the Electron 60-second inactivity restart and host signal', () => {
  const pilot = new ChromePilot({ userDataDir: 'x', executablePath: 'x' });
  assert.match(pilot.restartStalledWorker.toString(), /INACTIVITY-GUARD/);
  assert.match(pilot.handlePageSignal.toString(), /lastProgressAt < 60000/);
  assert.match(pilot.installPageRuntime.toString(), /__vtHost/);
});

test('PMath host failures use a clean retry screen and exponential backoff', () => {
  const pilot = new ChromePilot({ userDataDir: 'x', executablePath: 'x' });
  assert.match(pilot.detectPmathHostError.toString(), /520\|521\|522\|523\|524/);
  assert.match(pilot.showPmathOutageScreen.toString(), /PMath is temporarily unavailable/);
  assert.match(pilot.schedulePmathHostRetry.toString(), /PMATH_OUTAGE_RETRY_MAX_MS/);
  assert.match(pilot.guardPmathHost.toString(), /PMath host recovered/);
  assert.match(pilot.restartStalledWorker.toString(), /pmathHostOutage/);
});

test('pilot loads the shared ad blocker and never disables cleanup', () => {
  const pilot = new ChromePilot({ userDataDir: 'x', executablePath: 'x' });
  assert.match(pilot.adBlockSource, /VisionTap - Minimal Ad Blocker/);
  assert.doesNotMatch(pilot.injectSource, /__vtDisableAdCleanup\s*=\s*true/);
});

test('Kyaiko auto-converts PMath coins at the 30,000 threshold', () => {
  const pilot = new ChromePilot({ userDataDir: 'x', executablePath: 'x' });
  assert.match(pilot.iteration.toString(), /convertPmathCoins/);
  assert.match(pilot.convertPmathCoins.toString(), /pmathDoConvertAll/);
  assert.match(pilot.convertPmathCoins.toString(), /pmathConfirmPreparedConversion/);
  assert.match(pilot.convertPmathCoins.toString(), /expectedRemainder/);
  assert.match(pilot.convertPmathCoins.toString(), /PMATH_CONVERT_THRESHOLD/);
  assert.match(pilot.convertPmathCoins.toString(), /PMATH_CONVERT_RETRY_MS/);
});

test('all five ECNL accounts have isolated payout controllers', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'chrome-pilot.js'), 'utf8');
  for (const account of ['adaihbi', 'temi', 'axceling1001', 'clarencebopis', 'connormofu']) {
    assert.match(source, new RegExp(account));
  }
});

test('ECNL submission delays are staggered across the five accounts', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'chrome-pilot.js'), 'utf8');
  assert.match(source, /adaihbi: 0/);
  assert.match(source, /temi: 300/);
  assert.match(source, /axceling1001: 600/);
  assert.match(source, /clarencebopis: 900/);
  assert.match(source, /connormofu: 1100/);
});

'use strict';

function pageFailure(url, title, text) {
  const content = `${title} ${text}`;
  const code = content.match(/\bERR_[A-Z_]+\b|HTTP ERROR\s*\d{3}|\b(?:502 bad gateway|503 service unavailable|504 gateway timeout)\b/i);
  if (code) return code[0];
  const hostError = content.match(/\bserver\s+(?:is\s+)?down\b|\bruntime error\b|\bapplication error\b|web server is returning an unknown error|origin is unreachable|connection timed out|a timeout occurred|server error in ['"][^'"]+['"] application/i);
  if (hostError) return hostError[0];
  if (/^chrome-error:|^chrome:\/\/(?:crash|network-error)/i.test(url)) return 'Browser network error';
  const error = content.match(/this (?:page|site) (?:isn[’']t working|can[’']t be reached)|ERR_[A-Z_]+|HTTP ERROR\s*\d{3}|\b(?:502 bad gateway|503 service unavailable|504 gateway timeout)\b/i);
  return error ? error[0] : null;
}

async function guardBrowserRecovery(pilot, workUrl) {
  if (pilot.paused || pilot.encashment?.busy) return false;
  const now = Date.now();
  if (now < (pilot.nextBrowserRecoveryAt || 0)) {
    await pilot.setStatus('Recovering: checking the website again shortly…');
    return true;
  }
  if (now < (pilot.nextBrowserProbeAt || 0)) return false;
  pilot.nextBrowserProbeAt = now + 2000;
  let info;
  try {
    info = await pilot.page.evaluate(() => ({ url: location.href, title: document.title,
      text: (document.body?.innerText || '').slice(0, 6000) }));
  } catch (_) { info = { url: pilot.page.url(), title: '', text: '' }; }
  let reason = pageFailure(info.url, info.title, info.text);
  if (reason && pilot.lastNavigationFailure && now - pilot.lastNavigationFailure.at < 60000) reason = pilot.lastNavigationFailure.code;
  if (!reason && await pilot.detectVerification()) return false;
  const expected = info.url.split(/[?#]/)[0] === workUrl.split(/[?#]/)[0];
  if (!reason && !expected) {
    if (/\/login(?:[./?#]|$)/i.test(info.url)) {
      pilot.verificationHold = true;
      pilot.verificationClearStreak = pilot.verificationClearStreak || 0;
      pilot.unexpectedPageSince = 0;
      return false;
    }
    // Let normal post-login verification and payout navigation finish.
    if (pilot.verificationHold || /\/(?:convert-coins|withdraw|payout|encash)/i.test(info.url)) return false;
    pilot.unexpectedPageSince ||= now;
    if (now - pilot.unexpectedPageSince < 20000) return false;
    reason = 'Task page missing for 20 seconds';
  }
  if (!reason) {
    pilot.unexpectedPageSince = 0;
    // A page loading is not proof of earning progress; retain the retry count
    // until the site's points actually increase.
    pilot.browserRecoveryActive = false;
    if (!pilot.taskPageRecoveryPending) pilot.siteRecoveryWaitUntil = 0;
    return false;
  }
  if (pilot.siteRecovery) {
    const decision = await pilot.siteRecovery.failure(workUrl, reason);
    pilot.siteRecoveryWaitUntil = Date.now() + 30000;
    pilot.browserRecoveryActive = true;
    pilot.recoveryResumeUntil = Date.now() + 60000;
    if (pilot.lastRecoveryReason !== reason) {
      pilot.log(`BROWSER-RECOVERY: ${reason}; ${decision.detail}`);
      pilot.lastRecoveryReason = reason;
    }
    if (decision.wait) {
      pilot.nextBrowserRecoveryAt = Date.now() + 2000;
      await pilot.setStatus(`Recovering: ${reason}; ${decision.detail}. Shared check every 10 seconds…`);
      return true;
    }
    pilot.sharedSiteFailure = decision.shared;
  }
  pilot.browserRecoveryActive = true;
  pilot.browserRecoverySince ||= now;
  pilot.browserRecoveryAttempts = (pilot.browserRecoveryAttempts || 0) + 1;
  pilot.pending = null;
  pilot.epoch++;
  if (!pilot.sharedSiteFailure && pilot.browserRecoveryAttempts >= 6 && now - pilot.browserRecoverySince >= 60000) {
    await pilot.setStatus('Recovering: restarting this browser after repeated page failures…');
    pilot.log('BROWSER-RECOVERY: persistent page failures; restarting this account only.');
    process.exitCode = 75;
    pilot.running = false;
    await pilot.context?.close().catch(() => {});
    return true;
  }
  pilot.nextBrowserRecoveryAt = now + 10000;
  await pilot.setStatus(`Recovering: ${reason}. Reopening task page; retry in 10 seconds…`);
  pilot.log(`BROWSER-RECOVERY: ${reason}; reopening task page.`);
  await pilot.page.goto(workUrl, { waitUntil: 'commit', timeout: 8000 }).catch(() => {});
  return true;
}

function recordProgress(pilot, previousPoints, previousBalance) {
  previousPoints = pilot.confirmedPointSample ?? previousPoints;
  previousBalance = pilot.confirmedBalanceSample ?? previousBalance;
  const increased = previousPoints != null && pilot.pointsDone > previousPoints;
  const paidCycle = previousBalance != null && pilot.withdrawable > previousBalance;
  pilot.confirmedPointSample = pilot.pointsDone;
  pilot.confirmedBalanceSample = pilot.withdrawable;
  if (increased || paidCycle) {
    pilot.lastConfirmedProgressAt = Date.now();
    pilot.browserRecoveryAttempts = 0;
    pilot.browserRecoverySince = 0;
    pilot.browserRecoveryActive = false;
    pilot.siteRecoveryWaitUntil = 0;
    pilot.recoveryResumeUntil = 0;
    pilot.sharedSiteFailure = false;
    pilot.lastRecoveryReason = null;
    pilot.taskPageRecoveryPending = false;
    pilot.siteRecovery?.healthy(pilot.workUrl);
  }
}

module.exports = { pageFailure, guardBrowserRecovery, recordProgress };

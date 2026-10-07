'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');

test('all dashboard automation controls use the live control API', () => {
  assert.match(source, /function confirmControl\(/);
  assert.match(source, /fetch\('\/dashboard-control\?action='/);
  for (const action of ['pause', 'resume', 'refresh', 'restart']) {
    assert.match(source, new RegExp(`confirmControl\\(event,(?:'|&quot;)${action}`));
  }
  assert.match(source, /url\.pathname === "\/dashboard-control" && req\.method === "POST"/);
});

test('restart all restarts Chrome workers while refresh only reloads pages', () => {
  assert.match(source, /action === 'restart' \? restartChromeServices\(slot\) : sendChromeControl\(action, slot\)/);
  assert.match(source, /execSync\(`sudo systemctl restart \$\{units\}`/);
  assert.match(source, /action === 'restart' \|\| action === 'refresh' \? 'reload'/);
});

test('Kyaiko has direct working Play Pause and Restart controls', () => {
  assert.match(source, /isKyaikoCard\s*\?[^;]*runDashboardControl\(&quot;pause&quot;/s);
  assert.match(source, /runDashboardControl\(&quot;resume&quot;/);
  assert.match(source, /runDashboardControl\(&quot;restart&quot;/);
  assert.match(source, /title="Play"/);
  assert.match(source, /title="Restart"/);
});

test('Kyaiko uses balance history without a duplicate earnings history', () => {
  assert.match(source, /if\(!isKyaikoCard&&s\.earningsHistory&&s\.earningsHistory\.length>0\)/);
  assert.match(source, /Balance History \(10\)/);
});

test('dashboard includes all five ECNL slots and their controls', () => {
  for (const account of ['adaihbi', 'temi', 'axceling1001', 'clarencebopis', 'connormofu']) {
    assert.match(source, new RegExp(account));
  }
  assert.match(source, /'13':'clarencebopis'/);
  assert.match(source, /'16':'connormofu'/);
  assert.doesNotMatch(source, /\["13","16","17"\]/);
});

test('dashboard uses fixed distinct slot colors without a color picker', () => {
  for (const color of ['#8b5cf6', '#0ea5e9', '#14b8a6', '#22c55e', '#f59e0b', '#ec4899']) {
    assert.match(source, new RegExp(color, 'i'));
  }
  assert.doesNotMatch(source, /id="aiko-wheel"/);
  assert.doesNotMatch(source, /onclick="confirmSectionColor/);
  assert.match(source, /\.card-nm\{width:100%;text-align:center;font-size:21px/);
});

test('dashboard highlights todays payout and pending receipt reminder', () => {
  assert.match(source, /id="daily-payout"/);
  assert.match(source, /function renderDailyPayout\(/);
  assert.match(source, /pmathPayouts/);
  assert.match(source, /records\.map/);
  assert.match(source, /Today’s cash-out/);
  assert.match(source, /Not received yet\? Sign in online and check the payout history or GCash status\./);
  assert.match(source, /Payout receipt is confirmed\./);
  assert.match(source, /Cash-out is locked until this account reaches at least ₱300\./);
  assert.match(source, /Waiting For ₱300/);
});

test('Kyaiko balance mirrors the live PMath coin count', () => {
  assert.match(source, /const pilotCoins = Number\(pilotState\.withdrawable/);
  assert.match(source, /const dashboardWithdrawable = currentWithdrawable/);
  assert.match(source, /pointsDone = currentWithdrawable/);
});

test('every slot shows a live next cash-out earnings estimate after ETA', () => {
  assert.match(source, /function nextCashoutProjection\(/);
  assert.match(source, /Next cash-out estimate:/);
  assert.match(source, /cashoutProjection\.amount/);
  assert.match(source, /pointsPerHour/);
  assert.match(source, /below &#8369;300 minimum/);
  const etaIndex = source.indexOf('ETA: <span');
  const estimateIndex = source.indexOf('nextCashoutLine', etaIndex);
  assert.ok(etaIndex >= 0 && estimateIndex > etaIndex);
  assert.match(source, /next-cashout-line/);
});

test('top dashboard shows live weekday and monthly earnings forecasts', () => {
  assert.match(source, /id="forecast-week"/);
  assert.match(source, /id="forecast-month"/);
  assert.match(source, /function updateEarningsForecast\(slots\)/);
  assert.match(source, /pesosPerHour\*24\*5/);
  assert.match(source, /weekdayTotal\*\(52\/12\)/);
  assert.match(source, /PMath approximate/);
  assert.match(source, /updateEarningsForecast\(slots\)/);
});

test('balance history heading shows when each balance last changed', () => {
  assert.match(source, /function balanceHistoryTimerStart\(history\)/);
  assert.match(source, /function formatBalanceChangeTimer\(startTime,now\)/);
  assert.match(source, /return Number\(entries\[i\]\.time\|\|0\)/);
  assert.doesNotMatch(source, /return Number\(entries\[i-1\]\.time\|\|0\)/);
  assert.match(source, /Changed '\+parts\.slice\(0,3\)\.join\(' '\)\+' ago'/);
  assert.match(source, /class="bcol-hd-row"/);
  assert.match(source, /class="balance-age"/);
  assert.match(source, /data-balance-start/);
  assert.match(source, /function refreshBalanceChangeTimers\(\)/);
  assert.match(source, /refreshBalanceChangeTimers\(\)/);
});

test('top mini dashboard summarizes every slot cash-out detail', () => {
  assert.match(source, /id="mini-summary"/);
  assert.match(source, /function renderMiniSummary\(slots,pilots,now\)/);
  assert.match(source, /Current balance/);
  assert.match(source, /Next cash-out/);
  assert.match(source, /<b>When:<\/b>/);
  assert.match(source, /balanceHistoryTimerStart\(history\)/);
  assert.match(source, /nextCashoutProjection\(slot,now\)/);
  assert.match(source, /renderMiniSummary\(slots,pilots,new Date\(\)\)/);
  assert.match(source, /whenText:whenText/);
  assert.match(source, /Points'\)\+' \/ minute/);
  assert.match(source, /liveRate\.toFixed\(2\)/);
  assert.match(source, /mini-slot-stat rate/);
});

test('top summary highlights slot errors and attention states', () => {
  assert.match(source, /class="mini-slot-alert"/);
  assert.match(source, /class="mini-slot-alert warning"/);
  assert.match(source, /pilot\.verificationHold\|\|pilot\.paused\|\|pilot\.running===false/);
  assert.match(source, /failed\|offline\|server down\|runtime\|scanner could not/);
  assert.match(source, /Number\(pilot\.errors\|\|0\)/);
  assert.doesNotMatch(source, /cardState=problem\|\|errors>0/);
  assert.doesNotMatch(source, /alertHtml=problem\|\|errors>0/);
  assert.match(source, /has-error/);
  assert.match(source, /has-warning/);
});

test('earnings estimates use balance history, the real minimum, and an eligible schedule', () => {
  assert.match(source, /function balanceHistoryPesosPerHour\(history, isPmath\)/);
  assert.match(source, /const estimatedPesosPerHour = balanceHistoryPesosPerHour\(ms\.balanceHistory, isPmath\)/);
  assert.match(source, /etaHours = pesosNeeded \/ estimatedPesosPerHour/);
  assert.match(source, /estimatedPesosPerHour: estimatedPesosPerHour/);
  assert.match(source, /const tp = 300/);
  assert.doesNotMatch(source, /while \(currentWithdrawable >= tp\)/);
  assert.match(source, /while\(projected\.amount<300&&pesosPerHour>0/);
  assert.match(source, /historyRate>0\?historyRate:pointsRate/);
});

test('ECNL speed uses a stable five-minute rolling average with decimals', () => {
  assert.match(source, /function rollingPointsPerMinute\(history, nowMs, windowMs = 300000\)/);
  assert.match(source, /rollingPointsPerMinute\(sc\.pointsHistory \|\| slot\.pointsHistory \|\| \[\], nowMs\)/);
  assert.match(source, /Math\.round\(\(gained \/ elapsedMinutes\) \* 100\) \/ 100/);
  assert.doesNotMatch(source, /displayPpm = Math\.min\(9, Math\.max\(0, Math\.trunc\(displayPpm\)\)\)/);
});

test('dashboard has a final compact responsive layer for phones and tablets', () => {
  assert.match(source, /Final compact responsive layer/);
  assert.match(source, /@media\(max-width:900px\)/);
  assert.match(source, /@media\(max-width:620px\)/);
  assert.match(source, /@media\(max-width:360px\)/);
  assert.match(source, /\.mini-summary-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(source, /\.bhist-row:nth-child\(n\+6\)\{display:none\}/);
  assert.match(source, /\.crow\{grid-template-columns:1fr 1fr!important/);
});

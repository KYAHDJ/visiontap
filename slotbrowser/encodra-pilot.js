#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const { installColorHelper } = require('./local-color-helper');

const ACCOUNT = 'encodra';
const SLOT = '21';
const WORK_URL = 'https://www.encodradigital.site/tasks/color';
const STATE_DIR = process.env.VT_PILOT_STATE_DIR || path.join(os.homedir(), '.config', 'VisionTap Slots', 'state');
const STATE_FILE = path.join(STATE_DIR, 'chrome_encodra_state.json');
const COMMAND_FILE = path.join(STATE_DIR, 'chrome_encodra_command.json');
const USER_DATA = process.env.VT_CHROME_USER_DATA || path.join(os.homedir(), '.config', 'VisionTap-Chrome', 'encodra');
const CHROME = process.env.VT_CHROME_PATH || '/opt/google/chrome/chrome';
const WINDOW_SIZE = String(process.env.VT_WINDOW_SIZE || '512,1000').split(',').map(Number);
const WINDOW_POSITION = String(process.env.VT_WINDOW_POSITION || '2560,0').split(',').map(Number);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function writeState(data) {
  fs.mkdirSync(STATE_DIR, { recursive:true });
  const temp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, STATE_FILE);
}

async function main() {
  let context;
  let browser;
  let chromeProcess;
  let page;
  let paused = false;
  let lastNonce = null;
  let submissions = (() => { try { const saved=JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); return Number(saved.taskCount || saved.tasks) || 0; } catch (_) { return 0; } })();
  let helperSessionSubmissions = 0;
  let pointsDone = 0;
  let withdrawable = 0;
  let totalWithdrawn = 0;
  let lastLoginAttemptAt = 0;
  let checkpointStartedAt = 0;
  let tryAgainRecoveryStartedAt = 0;
  let checkpointRestartCount = 0;
  let lastCheckpointRestartAt = 0;
  let lastTryAgainRestartAt = 0;
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    checkpointRestartCount = Number(saved.checkpointRestartCount) || 0;
    lastCheckpointRestartAt = Number(saved.lastCheckpointRestartAt) || 0;
    lastTryAgainRestartAt = Number(saved.lastTryAgainRestartAt) || 0;
  } catch (_) {}
  const startedAt = Date.now();
  const base = () => ({ account:ACCOUNT, slot:SLOT, running:true, paused, tasks:submissions, taskCount:submissions,
    correctCount:submissions, sessionTasks:helperSessionSubmissions, errors:0, pointsDone, withdrawable, totalWithdrawn,
    loopStartTime:startedAt, time:new Date(Date.now()-startedAt).toISOString().slice(11,19), updatedAt:Date.now(),
    checkpointRestartCount, lastCheckpointRestartAt, lastTryAgainRestartAt });
  const save = extra => writeState({ ...base(), ...extra });
  const stop = async () => { save({running:false,status:'Stopped'}); try { await browser?.close(); } catch (_) {} try { chromeProcess?.kill('SIGTERM'); } catch (_) {} process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    save({status:'Starting Encodra Chrome…'});
    const debugPort = Number(process.env.VT_CHROME_DEBUG_PORT || 9225);
    chromeProcess = spawn(CHROME, [
      `--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${debugPort}`,
      '--remote-debugging-address=127.0.0.1','--no-sandbox','--disable-dev-shm-usage',
      '--disable-background-timer-throttling','--disable-renderer-backgrounding',
      `--window-size=${WINDOW_SIZE[0]},${WINDOW_SIZE[1]}`,
      `--window-position=${WINDOW_POSITION[0]},${WINDOW_POSITION[1]}`,WORK_URL
    ], {stdio:'ignore'});
    for (let attempt=0; attempt<30 && !browser; attempt++) {
      await sleep(500);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`).catch(() => null);
    }
    if (!browser) throw new Error('Normal Chrome did not expose its local control port');
    context = browser.contexts()[0];
    if (!context) throw new Error('Normal Chrome context was unavailable');
    const injection = `(${installColorHelper.toString()})('www.encodradigital.site');`;
    await context.addInitScript({ content:injection });
    const encodraPages = context.pages().filter(candidate => candidate.url().startsWith('https://www.encodradigital.site/'));
    page = encodraPages.at(-1) || context.pages()[0] || await context.newPage();
    for (const extra of encodraPages) if (extra !== page) await extra.close().catch(() => {});
    const boundsSession = await context.newCDPSession(page);
    const { windowId } = await boundsSession.send('Browser.getWindowForTarget');
    await boundsSession.send('Browser.setWindowBounds', {windowId,bounds:{
      left:WINDOW_POSITION[0],top:WINDOW_POSITION[1],width:WINDOW_SIZE[0],height:WINDOW_SIZE[1],windowState:'normal'
    }});
    await boundsSession.detach();
    if (page.url() !== WORK_URL) await page.goto(WORK_URL, { waitUntil:'domcontentloaded', timeout:60000 });
    while (true) {
      let command = null;
      try { command = JSON.parse(fs.readFileSync(COMMAND_FILE, 'utf8')); } catch (_) {}
      if (command?.nonce && command.nonce !== lastNonce) {
        lastNonce = command.nonce;
        if (command.action === 'pause') paused = true;
        if (command.action === 'resume') paused = false;
        if (command.action === 'reload') await page.reload({waitUntil:'domcontentloaded',timeout:60000});
        if (command.action === 'stop') await stop();
      }
      const pageState = await page.evaluate(() => {
        const visibleText = document.body?.innerText || '';
        const points = visibleText.match(/\bPOINTS\s*(\d[\d,]*)/i);
        const wallet = visibleText.match(/TASKING WALLET\s*₱?\s*([\d,.]+)/i);
        const withdrawn = visibleText.match(/TOTAL WITHDRAWN\s*₱?\s*([\d,.]+)/i);
        return { helper:window.__vtColorState || null, url:location.href, title:document.title,
          signedIn:!!document.querySelector('#task-answer'),
          pointsDone:points ? Number(points[1].replace(/,/g,'')) : null,
          withdrawable:wallet ? Number(wallet[1].replace(/,/g,'')) : null,
          totalWithdrawn:withdrawn ? Number(withdrawn[1].replace(/,/g,'')) : null };
      }).catch(() => null);
      if (Number.isFinite(pageState?.pointsDone)) pointsDone = pageState.pointsDone;
      if (Number.isFinite(pageState?.withdrawable)) withdrawable = pageState.withdrawable;
      if (Number.isFinite(pageState?.totalWithdrawn)) totalWithdrawn = pageState.totalWithdrawn;
      const observedSessionSubmissions = Number(pageState?.helper?.submissions) || 0;
      if (observedSessionSubmissions > helperSessionSubmissions) submissions += observedSessionSubmissions - helperSessionSubmissions;
      helperSessionSubmissions = observedSessionSubmissions;
      const securityCheckpoint = /vercel security checkpoint/i.test(String(pageState?.title || ''));
      if (securityCheckpoint) {
        if (!checkpointStartedAt) checkpointStartedAt = Date.now();
        save({
          status:'Vercel checkpoint detected — automatic refresh stopped; manual verification required.',
          currentUrl:pageState?.url || ''
        });
        await sleep(500);
        continue;
      }
      if (checkpointStartedAt || checkpointRestartCount || lastCheckpointRestartAt) {
        checkpointStartedAt = 0;
        checkpointRestartCount = 0;
        lastCheckpointRestartAt = 0;
      }
      const tryAgainStalled = !pageState?.signedIn
        && /try again clicked/i.test(String(pageState?.helper?.message || ''));
      if (tryAgainStalled) {
        if (!tryAgainRecoveryStartedAt) tryAgainRecoveryStartedAt = Date.now();
        const canRestartTryAgain = Date.now() - lastTryAgainRestartAt >= 60000;
        if (Date.now() - tryAgainRecoveryStartedAt >= 15000 && canRestartTryAgain) {
          checkpointRestartCount += 1;
          lastCheckpointRestartAt = Date.now();
          lastTryAgainRestartAt = Date.now();
          save({
            running:false,
            status:'Try Again did not restore a task — restarting Encodra automatically…',
            currentUrl:pageState?.url || '', checkpointRestartCount, lastCheckpointRestartAt, lastTryAgainRestartAt
          });
          throw new Error('Try Again recovery stalled; automatic Chrome restart requested');
        }
      } else {
        tryAgainRecoveryStartedAt = 0;
        if (pageState?.signedIn) lastTryAgainRestartAt = 0;
      }
      if (paused) {
        await page.evaluate(() => { window.__vtColorPaused = true; }).catch(() => {});
        save({status:'Paused', currentUrl:pageState?.url || ''});
      } else {
        await page.evaluate(() => { window.__vtColorPaused = false; }).catch(() => {});
        if (!pageState?.signedIn && /\/auth(?:$|[?#])/.test(String(pageState?.url || ''))
          && process.env.ENCODRA_LOGIN_USER && process.env.ENCODRA_LOGIN_PASSWORD
          && Date.now() - lastLoginAttemptAt > 60000) {
          lastLoginAttemptAt = Date.now();
          save({status:'Signing in to Encodra…',currentUrl:pageState.url});
          const user = page.locator('input:not([type="password"]):visible').first();
          const pass = page.locator('input[type="password"]:visible').first();
          await user.fill(process.env.ENCODRA_LOGIN_USER);
          await pass.fill(process.env.ENCODRA_LOGIN_PASSWORD);
          await page.locator('button:visible').filter({hasText:/log\s*in|sign\s*in/i}).first().click();
          await sleep(2500);
          await page.goto(WORK_URL, {waitUntil:'domcontentloaded',timeout:60000});
          await sleep(1500);
          continue;
        }
        const helperMissing = !pageState?.helper;
        if (helperMissing) await page.evaluate(injection).catch(() => {});
        const onAuthPage = /\/auth(?:$|[?#])/.test(String(pageState?.url || ''));
        save({status:onAuthPage ? 'Sign-in required' : (pageState?.helper?.message || 'Waiting for the next visible color task…'),
          currentUrl:pageState?.url || '', answer:pageState?.helper?.answer || null, shapeNumber:pageState?.helper?.shapeNumber || null,
          lastSubmittedAt:pageState?.helper?.lastSubmittedAt || null,
          checkpointRestartCount:0, lastCheckpointRestartAt:0, lastTryAgainRestartAt });
      }
      await sleep(500);
    }
  } catch (error) {
    writeState({ ...base(), running:false, status:`Error: ${error.message}`, error:String(error.stack || error), updatedAt:Date.now() });
    process.exitCode = 1;
    try { await browser?.close(); } catch (_) {}
    try { chromeProcess?.kill('SIGTERM'); } catch (_) {}
  }
}

main();

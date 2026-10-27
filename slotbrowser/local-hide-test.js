#!/usr/bin/env node
'use strict';

const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { chromium } = require('playwright-core');
const { installColorHelper } = require('./local-color-helper');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_PATH = path.join(__dirname, '..', 'state', 'local-hide-profile');

function normalizeUrl(value) {
  const input = String(value || '').trim();
  if (!input) throw new Error('A website address is required.');
  return new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
}

function installPageHider(hostname) {
  const currentHost = location.hostname.toLowerCase();
  if (currentHost !== hostname && !currentHost.endsWith(`.${hostname}`)) return;

  const apply = () => {
    if (document.getElementById('visiontap-local-hide-style')) return;
    const style = document.createElement('style');
    style.id = 'visiontap-local-hide-style';
    style.textContent = 'p, footer { display: none !important; visibility: hidden !important; }';
    const root = document.head || document.documentElement;
    if (root) root.appendChild(style);
  };

  apply();
  document.addEventListener('DOMContentLoaded', apply, { once: true });
}

async function main() {
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  let target;
  try {
    target = normalizeUrl(process.argv[2] || await terminal.question('Website to open: '));
  } finally {
    terminal.close();
  }

  const hostname = target.hostname.toLowerCase();
  const context = await chromium.launchPersistentContext(PROFILE_PATH, {
    executablePath: CHROME_PATH,
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
  });

  await context.addInitScript(installPageHider, hostname);
  await context.addInitScript(installColorHelper, hostname);
  const pages = context.pages();
  const page = pages[0] || await context.newPage();
  await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.evaluate(installPageHider, hostname);
  await page.evaluate(installColorHelper, hostname);
  console.log(`VisionTap Local Chrome is hiding <p> and <footer> on ${hostname}.`);
  console.log('Close the Chrome window when you are finished testing.');
  await new Promise(resolve => context.on('close', resolve));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Could not start VisionTap Local Chrome: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { normalizeUrl, installPageHider };

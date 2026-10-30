#!/usr/bin/env node
// A stand-in for Claude Code in the website screenshots (e2e/websiteShots.e2e.ts). In a terminal
// tab it draws a short, finished session on the Northwind storefront and then waits, so the agent
// pane looks like real work. A headless run (`-p`, request on stdin) answers with the text in
// WEBSITE_SHOTS_ANSWER when that file is set, so screens that ask an AI for something (Prompt
// Builder) get a believable answer instead of one line.
'use strict';

const { readFileSync } = require('node:fs');

const args = process.argv.slice(2);

if (args[0] === '--version') {
  process.stdout.write('2.0.62 (Claude Code)\n');
  process.exit(0);
}

/** A headless run: reads the request, prints the answer and exits. */
function answerHeadless() {
  process.stdin.resume();
  process.stdin.on('data', () => undefined);
  process.stdin.on('end', () => {
    const file = process.env.WEBSITE_SHOTS_ANSWER;
    let answer = 'Done.';
    try {
      if (file) answer = readFileSync(file, 'utf8');
    } catch {
      // No answer file: the short default is enough.
    }
    process.stdout.write(answer);
    process.exit(0);
  });
}

const esc = (code) => `\x1b[${code}m`;
const reset = esc(0);
const dim = (text) => `${esc(2)}${text}${reset}`;
const bold = (text) => `${esc(1)}${text}${reset}`;
const orange = (text) => `${esc('38;5;209')}${text}${reset}`;
const green = (text) => `${esc(32)}${text}${reset}`;
const red = (text) => `${esc(31)}${text}${reset}`;

// The agent pane sits next to a diff in the screenshot, so every line fits in 50 columns.
const BOX = 46;
const boxRow = (plain, styled, border) =>
  `${border('│')}${styled}${' '.repeat(BOX - 2 - plain.length)}${border('│')}`;
const boxEdge = (left, right, border) => border(`${left}${'─'.repeat(BOX - 2)}${right}`);

const lines = [
  boxEdge('╭', '╮', orange),
  boxRow(' ✻ Welcome to Claude Code', ` ${orange('✻')} Welcome to ${bold('Claude Code')}`, orange),
  boxRow(
    '   /help for help, /status for your setup',
    `   ${dim('/help for help, /status for your setup')}`,
    orange,
  ),
  boxEdge('╰', '╯', orange),
  '',
  `${dim('>')} Add discount codes to the cart. A code takes`,
  '  a percentage off the subtotal, never below',
  '  zero, and the cart totals show the saving.',
  '',
  `${orange('●')} I'll add a discount helper next to the money`,
  '  helpers, then use it in the cart totals.',
  '',
  `${green('●')} ${bold('Read')}(src/lib/price.ts)`,
  dim('  ⎿  Read 44 lines'),
  '',
  `${green('●')} ${bold('Update')}(src/lib/price.ts)`,
  dim('  ⎿  Updated src/lib/price.ts with 9 additions'),
  `     ${green('+ export function discountedBy(')}`,
  `     ${green('+   money: Money, percent: number): Money {')}`,
  `     ${red('- return { currency, amount: values.reduce(')}`,
  '',
  `${green('●')} ${bold('Update')}(src/cart/totals.ts)`,
  dim('  ⎿  Updated src/cart/totals.ts with 16 additions'),
  '',
  `${green('●')} ${bold('Write')}(src/lib/discounts.test.ts)`,
  dim('  ⎿  Wrote 19 lines to src/lib/discounts.test.ts'),
  '',
  `${green('●')} ${bold('Bash')}(pnpm test src)`,
  dim('  ⎿  Test Files  3 passed (3)'),
  dim('     Tests  21 passed (21)'),
  '',
  `${orange('●')} Discount codes are in. ${bold('discountedBy')} clamps the`,
  '  percentage, cartTotals() applies the active',
  '  code and returns the saving on its own line.',
  '  All 21 tests pass.',
  '',
  boxEdge('╭', '╮', dim),
  boxRow(' >', ' >', dim),
  boxEdge('╰', '╯', dim),
  `  ${dim('? for shortcuts')}`,
];

/** A terminal run: draws the finished session and stays open like the real CLI. */
function drawSession() {
  process.stdout.write(`${lines.join('\r\n')}\r\n`);
  // Stay open until the tab is closed.
  process.stdin.resume();
  process.stdin.on('data', () => undefined);
  setInterval(() => undefined, 60_000);
}

if (args.includes('-p') || args.includes('--print')) answerHeadless();
else drawSession();

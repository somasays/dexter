/**
 * Interactive setup wizard for the Dexter daemon.
 * Guides the user through creating their financial profile.
 */

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { saveProfile, type FinancialProfile, type Holding, type FinancialGoal } from './profile.js';

function rl(): readline.Interface {
  return readline.createInterface({ input, output });
}

async function ask(prompt: string, defaultValue?: string): Promise<string> {
  const io = rl();
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = await io.question(`${prompt}${suffix}: `);
    return answer.trim() || defaultValue || '';
  } finally {
    io.close();
  }
}

async function askChoice<T extends string>(
  prompt: string,
  choices: T[],
  defaultIndex = 0
): Promise<T> {
  console.log(`\n${prompt}`);
  choices.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
  const io = rl();
  try {
    const answer = await io.question(`Choice [${defaultIndex + 1}]: `);
    const idx = parseInt(answer.trim()) - 1;
    if (idx >= 0 && idx < choices.length) return choices[idx];
    return choices[defaultIndex];
  } finally {
    io.close();
  }
}

export async function runSetupWizard(): Promise<void> {
  console.log('\n══════════════════════════════════════════');
  console.log('  Dexter Autonomous Wealth Agent — Setup');
  console.log('══════════════════════════════════════════\n');
  console.log('This will create your financial profile at ~/.dexter/profile.json');
  console.log('You can update it anytime by editing the file or messaging Dexter.\n');

  // Basic identity
  const name = await ask('Your first name');

  // Delivery channel
  const channel = await askChoice('How should Dexter send you alerts?', [
    'telegram',
    'whatsapp',
  ] as const);

  let chatId = '';
  if (channel === 'telegram') {
    console.log('\nTo find your Telegram chat ID:');
    console.log('  1. Message @userinfobot on Telegram');
    console.log('  2. It will reply with your chat ID (a number like 123456789)');
    chatId = await ask('Your Telegram chat ID');
  } else {
    chatId = await ask('Your WhatsApp phone number (with country code, e.g. +15551234567)');
  }

  // Risk tolerance
  const riskTolerance = await askChoice(
    'Risk tolerance:',
    ['conservative', 'moderate', 'moderate-aggressive', 'aggressive'] as const,
    1
  );

  const timeHorizon = await ask('Investment time horizon (e.g. "10-15 years", "long-term")', 'long-term');
  const investmentPhilosophy = await ask(
    'Investment philosophy (optional, e.g. "growth at reasonable price")',
    ''
  );

  // Portfolio
  console.log('\n── Portfolio ──');
  console.log('Enter your holdings. Press Enter with empty ticker when done.\n');
  const holdings: Holding[] = [];
  while (true) {
    const ticker = (await ask('Ticker (or Enter to finish)')).toUpperCase();
    if (!ticker) break;
    const shares = parseFloat(await ask(`  ${ticker} — shares owned`));
    const costBasis = parseFloat(await ask(`  ${ticker} — avg cost per share ($)`));
    const account = await askChoice(
      `  ${ticker} — account type:`,
      ['taxable', 'IRA', 'Roth IRA', '401k', 'other'] as const,
      0
    );
    holdings.push({ ticker, shares, costBasis, account });
    console.log(`  ✓ Added ${shares} × ${ticker} @ $${costBasis}`);
  }

  // Watchlist
  const watchlistStr = await ask(
    '\nWatchlist tickers to monitor (comma-separated, e.g. TSLA,META)',
    ''
  );
  const watchlist = watchlistStr
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);

  // Goals
  console.log('\n── Financial Goals ──');
  console.log('Enter your main financial goal (you can add more later).\n');
  const goals: FinancialGoal[] = [];
  const goalDesc = await ask('Primary goal description (e.g. "Retire by age 55")', '');
  if (goalDesc) {
    const targetAmount = parseFloat(await ask('Target amount ($)'));
    const targetDate = await ask('Target date (YYYY-MM-DD)', '2038-01-01');
    goals.push({
      id: 'primary',
      description: goalDesc,
      targetAmount,
      targetDate,
      priority: 'primary',
    });
  }

  // Morning briefing
  const briefingCron = await ask(
    '\nMorning briefing schedule (cron, e.g. "0 7 * * 1-5" = weekdays 7am)',
    '0 7 * * 1-5'
  );
  const timezone = await ask('Your timezone (e.g. America/New_York)', 'America/New_York');

  // Build and save profile
  const profile: FinancialProfile = {
    name,
    timezone,
    currency: 'USD',
    riskTolerance,
    timeHorizon,
    investmentPhilosophy: investmentPhilosophy || undefined,
    goals,
    holdings,
    cash: 0,
    watchlist,
    constraints: { maxPositionPct: 25, rebalanceThreshold: 0.05 },
    delivery: { channel, chatId, timezone, briefingCron },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await saveProfile(profile);

  console.log('\n══════════════════════════════════════════');
  console.log('  Profile saved! ✓');
  console.log('══════════════════════════════════════════\n');
  console.log('Next steps:');
  if (channel === 'telegram') {
    console.log('  1. Create a bot via @BotFather on Telegram');
    console.log('  2. Add TELEGRAM_BOT_TOKEN=your-token to .env');
  }
  console.log('  3. Run: bun run dexter daemon');
  console.log('\nDexter will start monitoring your portfolio automatically.\n');
}

import { Command } from 'commander';
import { loadConfigFromFile } from '../config.js';
import { StateStore } from '../stateStore.js';
import { runStatus } from './status.js';
import { runPause } from './pause.js';
import { runCollectFees } from './collect-fees.js';
import { runEmergencyExit } from './emergency-exit.js';
import { runForceRebalance } from './force-rebalance.js';
import { runReport } from './report.js';
import { runClearDegraded } from './clear-degraded.js';
import { runReconcile } from './reconcile.js';
import { runCloseOrphan } from './close-orphan.js';

const CONFIG_PATH = process.env['BERT_MM_CONFIG'] ?? '/etc/bert-mm-bot/config.yaml';

function loadDeps() {
  const cfg = loadConfigFromFile(CONFIG_PATH);
  const state = new StateStore(cfg.statePath);
  state.init();
  return { cfg, state };
}

const program = new Command();

program
  .name('bert-mm-cli')
  .description('Operator tool for bert-mm-bot')
  .version('0.1.0');

program
  .command('status')
  .description('Print current bot state as JSON')
  .action(() => {
    const { cfg, state } = loadDeps();
    runStatus(cfg, state);
    state.close();
  });

program
  .command('pause')
  .description('Disable the bot (set enabled: false in config)')
  .action(() => {
    const { cfg, state } = loadDeps();
    runPause(cfg, state, CONFIG_PATH, true);
    state.close();
  });

program
  .command('resume')
  .description('Enable the bot (set enabled: true in config)')
  .action(() => {
    const { cfg, state } = loadDeps();
    runPause(cfg, state, CONFIG_PATH, false);
    state.close();
  });

program
  .command('collect-fees')
  .description('Close and reopen position to collect uncollected fees')
  .action(async () => {
    const { cfg, state } = loadDeps();
    try {
      await runCollectFees(cfg, state);
    } finally {
      state.close();
    }
  });

program
  .command('emergency-exit')
  .description('Interactively close position immediately (requires typing CLOSE)')
  .action(async () => {
    const { cfg, state } = loadDeps();
    try {
      await runEmergencyExit(cfg, state);
    } finally {
      state.close();
    }
  });

program
  .command('rebalance')
  .description('Force a rebalance bypassing cooldowns')
  .requiredOption('-f, --force', 'Required flag to confirm forced rebalance')
  .action(async () => {
    const { cfg, state } = loadDeps();
    try {
      await runForceRebalance(cfg, state);
    } finally {
      state.close();
    }
  });

program
  .command('report')
  .description('Print rebalance log and operator actions for last N days')
  .requiredOption('-d, --days <number>', 'Number of days to include', (v) => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 1) throw new Error('--days must be a positive integer');
    return n;
  })
  .action((opts: { days: number }) => {
    const { cfg, state } = loadDeps();
    runReport(cfg, state, opts.days);
    state.close();
  });

program
  .command('clear-degraded')
  .description('Clear the degraded flag (requires typing YES)')
  .action(async () => {
    const { cfg, state } = loadDeps();
    try {
      await runClearDegraded(cfg, state);
    } finally {
      state.close();
    }
  });

program
  .command('reconcile')
  .description('Re-run reconciler; if MISMATCH, prompt to overwrite state from chain')
  .action(async () => {
    const { cfg, state } = loadDeps();
    try {
      await runReconcile(cfg, state);
    } finally {
      state.close();
    }
  });

program
  .command('close-orphan')
  .description('Close a position by NFT mint (for orphaned positions not tracked in state)')
  .requiredOption('--nft <mint>', 'NFT mint address of the orphaned position')
  .action(async (opts: { nft: string }) => {
    const { cfg, state } = loadDeps();
    try {
      await runCloseOrphan(cfg, state, opts.nft);
    } finally {
      state.close();
    }
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  process.stderr.write(`CLI error: ${String(e)}\n`);
  process.exit(1);
});

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { PublicKey, Transaction, sendAndConfirmTransaction, Keypair, Connection } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { loadConfigFromFile } from '../config.js';
import { StateStore } from '../stateStore.js';
import { DepositorStore } from '../vault/depositorStore.js';
import { loadMasterKey } from '../vault/encryption.js';
import { runStatus } from './status.js';
import { runPause } from './pause.js';
import { runCollectFees } from './collect-fees.js';
import { runEmergencyExit } from './emergency-exit.js';
import { runForceRebalance } from './force-rebalance.js';
import { runReport } from './report.js';
import { runClearDegraded } from './clear-degraded.js';
import { runReconcile } from './reconcile.js';
import { runCloseOrphan } from './close-orphan.js';
import { runBootstrap } from './vault-bootstrap.js';

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

program
  .command('vault-bootstrap')
  .description(
    'One-time: initialise the vault with a founding operator deposit + opening NAV. ' +
      'Fails if the vault already has users. Requires VAULT_MASTER_KEY env var.',
  )
  .requiredOption(
    '--initial-nav-usd <amount>',
    'Opening NAV in USD (operator receives this many shares @ $1 each)',
    (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--initial-nav-usd must be a positive number');
      return n;
    },
  )
  .option(
    '--operator-telegram-id <id>',
    'Override operator Telegram ID (defaults to vault.operatorTelegramId from config)',
    (v) => {
      const n = Number(v);
      if (!Number.isInteger(n)) throw new Error('--operator-telegram-id must be an integer');
      return n;
    },
  )
  .action(async (opts: { initialNavUsd: number; operatorTelegramId?: number }) => {
    const { cfg, state } = loadDeps();
    try {
      if (!cfg.vault) {
        throw new Error('vault-bootstrap: config has no `vault` section; add it before bootstrapping');
      }
      const operatorTelegramId = opts.operatorTelegramId ?? cfg.vault.operatorTelegramId;
      const masterKey = loadMasterKey();
      const store = new DepositorStore(state);

      // Build an ensureAta fn that creates the BERT ATA for the operator deposit
      // address using the bot's payer keypair (mirrors main.ts). Non-fatal on
      // failure — the sweeper can create it later if needed.
      const keyJson = JSON.parse(readFileSync(cfg.keyfilePath, 'utf8')) as number[];
      const payer = Keypair.fromSecretKey(Uint8Array.from(keyJson));
      const connection = new Connection(cfg.rpcPrimary, 'confirmed');
      const bertMintPk = new PublicKey(cfg.bertMint);
      const ensureAta = async (addr: string): Promise<void> => {
        try {
          const owner = new PublicKey(addr);
          const ata = getAssociatedTokenAddressSync(bertMintPk, owner, false);
          const existing = await connection.getAccountInfo(ata);
          if (existing !== null) {
            process.stdout.write(`BERT ATA already exists: ${ata.toBase58()}\n`);
            return;
          }
          const tx = new Transaction().add(
            createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, bertMintPk),
          );
          const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
          process.stdout.write(`BERT ATA created: ${ata.toBase58()} (sig=${sig})\n`);
        } catch (e) {
          process.stderr.write(
            `warning: BERT ATA creation failed (non-fatal — sweeper can create it later): ${String(e)}\n`,
          );
        }
      };

      const result = await runBootstrap({
        store,
        masterKey,
        operatorTelegramId,
        initialNavUsd: opts.initialNavUsd,
        ensureAta,
        now: Date.now(),
      });

      process.stdout.write(
        [
          'vault-bootstrap: success',
          `  operator telegramId: ${result.operatorTelegramId}`,
          `  operator deposit address: ${result.depositAddress}`,
          `  initial shares minted: ${result.initialShares}`,
          `  opening NAV/share: $${result.navPerShare.toFixed(4)}`,
          '',
        ].join('\n'),
      );
    } finally {
      state.close();
    }
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  process.stderr.write(`CLI error: ${String(e)}\n`);
  process.exit(1);
});

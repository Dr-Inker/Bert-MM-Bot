import * as readline from 'node:readline/promises';
import { Notifier } from '../notifier.js';
import { reconcile } from '../reconciler.js';
import type { StateStore } from '../stateStore.js';
import type { BotConfig } from '../types.js';
import { buildRuntime, osUser } from './_helpers.js';

export async function runReconcile(cfg: BotConfig, state: StateStore): Promise<void> {
  const { raydium } = await buildRuntime(cfg);
  const notifier = new Notifier(cfg.notifier ?? {});

  const stored = state.getCurrentPosition();
  const onchain = stored ? await raydium.getPosition(stored.nftMint, 0) : null;
  const rec = reconcile(stored, onchain);

  process.stdout.write(`Reconcile result: ${rec.kind}\n`);

  if (rec.kind !== 'MISMATCH') {
    process.stdout.write('State is consistent — no action needed.\n');
    state.recordOperatorAction({ ts: Date.now(), command: 'reconcile:ok', osUser: osUser() });
    return;
  }

  process.stdout.write(`MISMATCH: ${rec.reason}\n`);
  process.stdout.write(
    `  stored: ${stored ? JSON.stringify(stored) : 'null'}\n`,
  );
  process.stdout.write(`  onchain: ${onchain ? JSON.stringify({ nftMint: onchain.nftMint, range: onchain.range }) : 'null'}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let overwrite = false;
  try {
    const answer = await rl.question(
      'Overwrite state.db with on-chain data? Type YES to confirm (any other input aborts): ',
    );
    overwrite = answer.trim() === 'YES';
  } finally {
    rl.close();
  }

  if (!overwrite) {
    process.stdout.write('Aborted — state unchanged.\n');
    return;
  }

  if (onchain) {
    state.setCurrentPosition({
      nftMint: onchain.nftMint,
      lowerUsd: onchain.range.lowerBertUsd,
      upperUsd: onchain.range.upperBertUsd,
      centerUsd: onchain.range.centerBertUsd,
      openedAt: onchain.openedAt,
    });
    process.stdout.write(`State overwritten with on-chain position ${onchain.nftMint}\n`);
  } else {
    state.clearCurrentPosition();
    process.stdout.write('On-chain has no position — state cleared.\n');
  }

  state.recordOperatorAction({
    ts: Date.now(),
    command: 'reconcile:overwrite',
    osUser: osUser(),
  });
  await notifier.send('WARN', `Operator reconcile overwrite by ${osUser()}: ${rec.reason}`);
}

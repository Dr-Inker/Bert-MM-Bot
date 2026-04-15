import * as readline from 'node:readline/promises';
import { Notifier } from '../notifier.js';
import type { StateStore } from '../stateStore.js';
import type { BotConfig } from '../types.js';
import { buildRuntime, osUser } from './_helpers.js';

export async function runEmergencyExit(cfg: BotConfig, state: StateStore): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = await rl.question(
      'WARNING: This will close the position immediately. Type CLOSE to confirm: ',
    );
    if (answer.trim() !== 'CLOSE') {
      process.stdout.write('Aborted.\n');
      return;
    }
  } finally {
    rl.close();
  }

  const { raydium, submitter } = await buildRuntime(cfg);
  const notifier = new Notifier(cfg.notifier ?? {});

  const storedPos = state.getCurrentPosition();
  if (!storedPos) {
    process.stdout.write('No active position in state — nothing to close.\n');
    state.recordOperatorAction({ ts: Date.now(), command: 'emergency-exit:no-position', osUser: osUser() });
    return;
  }

  process.stdout.write(`Closing position ${storedPos.nftMint}...\n`);

  let closeSig: string;
  try {
    const closeTx = await raydium.buildClosePositionTx(storedPos.nftMint);
    closeSig = await submitter.submit(closeTx.tx, {
      priorityFeeMicroLamports: cfg.priorityFeeMicroLamports,
      dryRun: cfg.dryRun,
    });
  } catch (e) {
    process.stderr.write(`ERROR: Close failed: ${String(e)}\n`);
    await notifier.send('CRITICAL', `emergency-exit FAILED: ${String(e)}`);
    process.exit(1);
  }

  if (!cfg.dryRun) {
    state.clearCurrentPosition();
  }

  state.recordOperatorAction({ ts: Date.now(), command: 'emergency-exit', osUser: osUser() });
  await notifier.send('CRITICAL', `EMERGENCY EXIT executed by ${osUser()} — closeSig=${closeSig}`);
  process.stdout.write(`Position closed. sig=${closeSig}${cfg.dryRun ? ' (DRY RUN)' : ''}\n`);
}

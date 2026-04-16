import * as readline from 'node:readline/promises';
import { Notifier } from '../notifier.js';
import type { StateStore } from '../stateStore.js';
import type { BotConfig } from '../types.js';
import { buildRuntime, osUser } from './_helpers.js';

export async function runCloseOrphan(cfg: BotConfig, state: StateStore, nftMint: string): Promise<void> {
  const { raydium, submitter } = await buildRuntime(cfg);
  const notifier = new Notifier(cfg.notifier ?? {});

  // Verify the position exists on-chain
  process.stdout.write(`Looking up position NFT ${nftMint}...\n`);

  let closeTx: Awaited<ReturnType<typeof raydium.buildClosePositionTx>>;
  try {
    closeTx = await raydium.buildClosePositionTx(nftMint);
  } catch (e) {
    process.stderr.write(`ERROR: Cannot build close tx: ${String(e)}\n`);
    process.exit(1);
  }

  const bertOut = Number(closeTx.expectedBertOut) / 1e6;
  const solOut = Number(closeTx.expectedSolOut) / 1e9;
  process.stdout.write(`Position found. Expected recovery: ~${bertOut.toFixed(2)} BERT + ~${solOut.toFixed(6)} SOL\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Type CLOSE to confirm closing this orphan position: ');
    if (answer.trim() !== 'CLOSE') {
      process.stdout.write('Aborted.\n');
      return;
    }
  } finally {
    rl.close();
  }

  let closeSig: string;
  try {
    closeSig = await submitter.submit(closeTx.tx, {
      priorityFeeMicroLamports: cfg.priorityFeeMicroLamports,
      dryRun: cfg.dryRun,
    });
  } catch (e) {
    process.stderr.write(`ERROR: Close failed: ${String(e)}\n`);
    await notifier.send('CRITICAL', `close-orphan FAILED for ${nftMint}: ${String(e)}`);
    process.exit(1);
  }

  state.recordOperatorAction({ ts: Date.now(), command: `close-orphan:${nftMint}`, osUser: osUser() });
  await notifier.send('INFO', `Orphan position ${nftMint} closed by ${osUser()} — sig=${closeSig}`);
  process.stdout.write(`Orphan position closed. sig=${closeSig}${cfg.dryRun ? ' (DRY RUN)' : ''}\n`);
}

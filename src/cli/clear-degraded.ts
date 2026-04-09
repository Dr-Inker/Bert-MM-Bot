import * as readline from 'node:readline/promises';
import type { StateStore } from '../stateStore.js';
import type { BotConfig } from '../types.js';
import { osUser } from './_helpers.js';

export async function runClearDegraded(cfg: BotConfig, state: StateStore): Promise<void> {
  void cfg;

  if (!state.isDegraded()) {
    process.stdout.write('Bot is not in degraded state — nothing to clear.\n');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = await rl.question('Bot is DEGRADED. Type YES to clear degraded flag: ');
    if (answer.trim() !== 'YES') {
      process.stdout.write('Aborted.\n');
      return;
    }
  } finally {
    rl.close();
  }

  state.setDegraded(false, 'cleared by operator');
  state.recordOperatorAction({ ts: Date.now(), command: 'clear-degraded', osUser: osUser() });
  process.stdout.write('Degraded flag cleared.\n');
}

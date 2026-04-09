import { Notifier } from '../notifier.js';
import { fetchAllSources } from '../priceOracle.js';
import { makeFetchers } from '../priceFetchers.js';
import { computeTrustedMid } from '../priceOracle.js';
import { executeRebalance } from '../rebalancer.js';
import type { StateStore } from '../stateStore.js';
import type { BotConfig } from '../types.js';
import { buildRuntime, osUser } from './_helpers.js';

export async function runCollectFees(cfg: BotConfig, state: StateStore): Promise<void> {
  const { raydium, submitter } = await buildRuntime(cfg);
  const notifier = new Notifier(cfg.notifier);

  const fetchers = makeFetchers(raydium, cfg.poolAddress);
  const samples = await fetchAllSources(fetchers);
  const now = Date.now();
  const solUsd = samples[0]?.solUsd ?? 150;
  const mid = computeTrustedMid(samples, solUsd, now, cfg.oracleDivergenceBps);

  if (!mid) {
    process.stderr.write('ERROR: No trusted mid price available — aborting collect-fees\n');
    process.exit(1);
  }

  const storedPos = state.getCurrentPosition();
  const currentPosition = storedPos
    ? await raydium.getPosition(storedPos.nftMint, mid.solUsd)
    : null;

  process.stdout.write('collect-fees: closing + reopening position to collect uncollected fees...\n');

  const result = await executeRebalance(
    { raydium, submitter, state, notifier, config: cfg },
    mid,
    currentPosition,
    'operator:collect-fees',
  );

  state.recordOperatorAction({ ts: Date.now(), command: 'collect-fees', osUser: osUser() });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  if (result.kind === 'FAILED') process.exit(1);
}

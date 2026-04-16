import { Connection } from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';
import { readFileSync } from 'fs';
import { parse } from 'yaml';

async function main() {
  const cfg = parse(readFileSync('/etc/bert-mm-bot/config.yaml', 'utf8')) as { rpcPrimary: string };
  const conn = new Connection(cfg.rpcPrimary, 'confirmed');

  const { presetParameter, presetParameter2 } = await DLMM.getAllPresetParameters(conn);
  const all = [...presetParameter, ...presetParameter2];

  const lowFee = all
    .map(p => ({
      binStep: p.account.binStep,
      baseFactor: p.account.baseFactor,
      fee: (p.account.binStep * p.account.baseFactor * 10) / 1e9,
      pubkey: p.publicKey.toBase58(),
    }))
    .filter(p => p.fee <= 0.003)
    .sort((a, b) => a.fee - b.fee);

  console.log('=== Presets with fee <= 0.30% ===');
  for (const p of lowFee) {
    console.log(`  bin_step=${String(p.binStep).padStart(4)}  base_factor=${String(p.baseFactor).padStart(6)}  fee=${(p.fee * 100).toFixed(4)}%  ${p.pubkey}`);
  }
  console.log(`\nTotal: ${lowFee.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });

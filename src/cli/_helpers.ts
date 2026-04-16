import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { createVenueClient, type VenueClient } from '../venueClient.js';
import { TxSubmitter } from '../txSubmitter.js';
import type { BotConfig } from '../types.js';
import type { TxSubmitter as TxSubmitterType } from '../txSubmitter.js';
import type { Connection } from '@solana/web3.js';

export interface Runtime {
  raydium: VenueClient;
  submitter: TxSubmitterType;
  payer: Keypair;
  connection: Connection;
}

export async function buildRuntime(cfg: BotConfig): Promise<Runtime> {
  const keyJson = JSON.parse(readFileSync(cfg.keyfilePath, 'utf8')) as number[];
  const payer = Keypair.fromSecretKey(Uint8Array.from(keyJson));

  const raydium = await createVenueClient(
    cfg.venue,
    cfg.rpcPrimary,
    cfg.rpcFallback,
    cfg.poolAddress,
    cfg.bertMint,
    payer,
  );
  await raydium.init();

  const connection = raydium.getConnection();
  const submitter = new TxSubmitter(connection, payer);

  return { raydium, submitter, payer, connection };
}

export function osUser(): string {
  return process.env['USER'] ?? process.env['LOGNAME'] ?? 'unknown';
}

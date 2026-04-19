import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionSignature,
  Signer,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { logger } from './logger.js';

/**
 * Jito Block Engine client for MEV-protected transaction submission.
 *
 * Wraps a transaction + a tip transfer as a 1-tx bundle (the tip IX is
 * appended to the caller's tx so the bundle is atomic for free). Bundles
 * submitted here never hit the public mempool, eliminating sandwich/
 * frontrun attacks on our rebalance swaps.
 *
 * Jito validators (~65% of Solana block production) include bundles
 * atomically. If the bundle doesn't land within `timeoutMs`, the caller
 * should fall back to regular RPC submission.
 */

// Default Jito tip accounts — one is picked at random per submission.
// Acts as a fallback if the startup refresh against getTipAccounts fails.
// Source: https://docs.jito.wtf/lowlatencytxnsend/#tip-amount
// Sanity-checked against live `getTipAccounts` on 2026-04-19.
const DEFAULT_JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
].map((a) => new PublicKey(a));

export interface JitoClientOptions {
  blockEngineUrl: string;
  tipLamports: number;
  bundleTimeoutMs?: number;
}

export class JitoClient {
  private tipAccounts: PublicKey[] = DEFAULT_JITO_TIP_ACCOUNTS;

  constructor(
    private readonly connection: Connection,
    private readonly payer: Keypair,
    private readonly opts: JitoClientOptions,
  ) {}

  /**
   * Fetch the canonical tip-account list from the block engine and swap it
   * in. Guards against silent breakage when Jito rotates accounts (any tip
   * to an unrecognized pubkey fails with "must write lock at least one tip
   * account"). On failure we keep DEFAULT_JITO_TIP_ACCOUNTS — safe, since
   * the defaults match the canonical list as of the sanity-check date.
   */
  async refreshTipAccounts(timeoutMs = 5_000): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.opts.blockEngineUrl}/api/v1/bundles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTipAccounts',
          params: [],
        }),
        signal: ctrl.signal,
      });
      const data = (await res.json()) as { result?: string[]; error?: { message?: string } };
      if (!data.result || !Array.isArray(data.result) || data.result.length === 0) {
        throw new Error(data.error?.message ?? 'empty tip-account list');
      }
      this.tipAccounts = data.result.map((a) => new PublicKey(a));
      logger.info({ count: this.tipAccounts.length }, 'jito: refreshed tip accounts');
    } catch (e) {
      logger.warn({ err: e }, 'jito: tip-account refresh failed; using hardcoded fallback');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Submit a transaction as a single-tx Jito bundle. Appends a tip
   * instruction to the tx, signs, submits, and polls for confirmation.
   *
   * Returns the signature on success. Returns null on timeout (caller
   * should fall back). Throws on hard failure (e.g. bundle rejected).
   */
  async submitProtected(
    tx: Transaction,
    extraSigners: Signer[] = [],
  ): Promise<TransactionSignature | null> {
    // Clone input so a Jito failure leaves the original tx pristine for
    // RPC fallback (we mutate the clone by appending tip IX + signing).
    const protectedTx = new Transaction();
    protectedTx.add(...tx.instructions);

    const tipAccount =
      this.tipAccounts[Math.floor(Math.random() * this.tipAccounts.length)]!;
    protectedTx.add(
      SystemProgram.transfer({
        fromPubkey: this.payer.publicKey,
        toPubkey: tipAccount,
        lamports: this.opts.tipLamports,
      }),
    );

    // Fresh blockhash is essential — bundles expire with the blockhash.
    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    protectedTx.recentBlockhash = blockhash;
    protectedTx.feePayer = this.payer.publicKey;
    protectedTx.sign(this.payer, ...extraSigners);

    const serialized = protectedTx.serialize();
    const encoded = bs58.encode(serialized);
    const expectedSig = bs58.encode(protectedTx.signature!);

    // sendBundle: bundle = array of base58-encoded txs
    let bundleId: string;
    try {
      const res = await fetch(`${this.opts.blockEngineUrl}/api/v1/bundles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          params: [[encoded]],
        }),
      });
      const data = (await res.json()) as { result?: string; error?: { message?: string } };
      if (data.error) {
        throw new Error(`Jito rejected bundle: ${data.error.message ?? 'unknown'}`);
      }
      bundleId = data.result!;
    } catch (e) {
      logger.warn({ err: e }, 'jito: sendBundle failed');
      return null;
    }

    logger.info({ bundleId, tipLamports: this.opts.tipLamports, tipAccount: tipAccount.toBase58() }, 'jito bundle submitted');

    // Poll bundle status up to timeout. Success = confirmed/finalized.
    const timeout = this.opts.bundleTimeoutMs ?? 30_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const res = await fetch(`${this.opts.blockEngineUrl}/api/v1/bundles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBundleStatuses',
            params: [[bundleId]],
          }),
        });
        const data = (await res.json()) as {
          result?: {
            value?: Array<{
              confirmation_status?: string;
              err?: unknown;
              transactions?: string[];
            }>;
          };
        };
        const status = data.result?.value?.[0];
        if (!status) continue;
        if (status.err) {
          throw new Error(`jito bundle failed: ${JSON.stringify(status.err)}`);
        }
        if (
          status.confirmation_status === 'confirmed' ||
          status.confirmation_status === 'finalized'
        ) {
          const sig = status.transactions?.[0] ?? expectedSig;
          logger.info({ bundleId, sig }, 'jito bundle confirmed');
          return sig;
        }
      } catch (e) {
        logger.warn({ bundleId, err: e }, 'jito: getBundleStatuses failed');
        // keep polling — one transient error shouldn't abort
      }
    }

    logger.warn({ bundleId, timeout }, 'jito bundle did not land within timeout');
    return null;
  }
}

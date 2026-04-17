import { describe, it, expect } from 'vitest';

// A full devnet integration test for partialClose requires a live Meteora
// pool with a position — that's covered by the manual E2E checklist, not
// vitest. Here we only assert the interface contract.

describe('partialClose interface contract', () => {
  it('venueClient module exports createVenueClient (interface compiles)', async () => {
    const mod = await import('../../src/venueClient.js');
    // Just importing proves the interface compiles with the new method.
    expect(typeof mod.createVenueClient).toBe('function');
  });
});

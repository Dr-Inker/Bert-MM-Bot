import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Notifier } from '../src/notifier.js';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 200 } as Response);
});

describe('Notifier', () => {
  const channels = {
    discord: {
      webhookInfo: 'https://d.invalid/info',
      webhookCritical: 'https://d.invalid/critical',
    },
  };

  it('routes INFO to info webhook', async () => {
    const n = new Notifier(channels);
    await n.send('INFO', 'hello');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://d.invalid/info');
  });

  it('routes CRITICAL to critical webhook', async () => {
    const n = new Notifier(channels);
    await n.send('CRITICAL', 'fire');
    expect(mockFetch.mock.calls[0][0]).toBe('https://d.invalid/critical');
  });

  it('prefixes message with severity', async () => {
    const n = new Notifier(channels);
    await n.send('WARN', 'minor issue');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.content).toMatch(/\[WARN\]/);
    expect(body.content).toMatch(/minor issue/);
  });

  it('does not throw on webhook failure', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    const n = new Notifier(channels);
    await expect(n.send('INFO', 'test')).resolves.not.toThrow();
  });
});

import { readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { StateStore } from '../stateStore.js';
import type { BotConfig } from '../types.js';
import { osUser } from './_helpers.js';

export function runPause(cfg: BotConfig, state: StateStore, configPath: string, pause: boolean): void {
  const raw = readFileSync(configPath, 'utf8');
  const doc = parseYaml(raw) as Record<string, unknown>;
  doc['enabled'] = !pause;
  writeFileSync(configPath, stringifyYaml(doc));

  const command = pause ? 'pause' : 'resume';
  state.recordOperatorAction({ ts: Date.now(), command, osUser: osUser() });

  const action = pause ? 'PAUSED' : 'RESUMED';
  process.stdout.write(`Bot ${action}. Config updated at ${configPath}\n`);
}

/** Loads and validates ./config.json (zod). Throws if missing or malformed. */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';

const configSchema = z.object({
  botToken: z.string().min(1),
  allowedUserId: z.number().int().positive(),
  cwd: z.string().min(1),
});

export type Config = z.infer<typeof configSchema>;

const CONFIG_PATH = resolve(process.cwd(), 'config.json');

/** Reads ./config.json and validates it. Returns null when absent (pure multi-bot setups have no legacy config). */
export function loadConfig(): Config | null {
  if (!existsSync(CONFIG_PATH)) {
    return null;
  }
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  return configSchema.parse(parsed);
}

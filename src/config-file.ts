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

/** Reads ./config.json and validates against the schema. Throws on missing file or invalid shape. */
export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Config not found at ${CONFIG_PATH}. Copy config.example.json to config.json and fill it in.`);
  }
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  return configSchema.parse(parsed);
}

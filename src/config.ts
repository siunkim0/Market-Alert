import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const optionalStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1, 'TELEGRAM_BOT_TOKEN이 비어 있습니다'),
  TELEGRAM_ALLOWED_CHAT_IDS: z
    .string()
    .trim()
    .min(1, 'TELEGRAM_ALLOWED_CHAT_IDS가 비어 있습니다')
    .transform((s, ctx) => {
      const ids = s.split(',').map((x) => x.trim()).filter(Boolean).map(Number);
      if (ids.length === 0 || ids.some((n) => !Number.isSafeInteger(n))) {
        ctx.addIssue({ code: 'custom', message: 'chat_id는 쉼표로 구분한 정수여야 합니다' });
        return z.NEVER;
      }
      return ids;
    }),
  ANTHROPIC_API_KEY: optionalStr,
  ANTHROPIC_MODEL_FAST: z.string().default('claude-haiku-5-5'),
  ANTHROPIC_MODEL_SMART: z.string().default('claude-sonnet-5-5'),
  TV_SESSION: optionalStr,
  TV_SIGNATURE: optionalStr,
  BINANCE_API_KEY: optionalStr,
  BINANCE_API_SECRET: optionalStr,
  NAVER_CLIENT_ID: optionalStr,
  NAVER_CLIENT_SECRET: optionalStr,
  FINNHUB_API_KEY: optionalStr,
  DB_PATH: z.string().default('./data/fivesigma.db'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});
export type Env = z.infer<typeof EnvSchema>;

const hhmm = z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM 형식이어야 합니다');

export const ConfigSchema = z.object({
  defaults: z.object({
    mode: z.enum(['sigma', 'pct']).default('sigma'),
    sigma_threshold: z.number().positive().default(3),
    pct_threshold: z.number().positive().default(5),
    sigma_window: z.number().int().min(5).default(20),
    volume_ratio: z.number().positive().default(3),
    volume_enabled_us: z.boolean().default(true),
  }),
  escalation: z.object({
    sigma_steps: z.array(z.number().positive()).min(1),
    pct_step: z.number().positive(),
  }),
  level_default_proximity_pct: z.number().nonnegative().default(2),
  delay: z.object({
    lag_threshold_sec: z.number().positive().default(60),
    lag_persist_min: z.number().positive().default(5),
  }),
  benchmarks: z.record(z.string(), z.string()).default({}),
  digest: z.object({ krx: hhmm, us: hhmm, crypto: hhmm }),
  daily_bars_refresh: z.array(hhmm).default(['08:30', '09:01', '21:30']),
  journal_sync_minutes: z.number().positive().default(10),
  trading_rules: z.object({
    max_trades_per_day: z.number().int().positive(),
    max_loss_R: z.number().positive(),
    require_stop_loss: z.boolean(),
  }),
});
export type AppConfig = z.infer<typeof ConfigSchema>;

export const AliasEntrySchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.union([z.string(), z.number()]).transform(String)).default([]),
});
export const AliasesSchema = z.record(z.string().regex(/^[^:\s]+:[^:\s]+$/, 'EXCHANGE:TICKER 형식이어야 합니다'), AliasEntrySchema);
export type Aliases = z.infer<typeof AliasesSchema>;

export interface LoadedConfig {
  rootDir: string;
  env: Env;
  cfg: AppConfig;
  aliases: Aliases;
  dbPath: string;
}

function readYaml(file: string): unknown {
  return parseYaml(readFileSync(file, 'utf8'));
}

function formatZodError(where: string, err: z.ZodError): Error {
  const lines = err.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  return new Error(`${where} 설정 오류:\n${lines.join('\n')}`);
}

export function parseConfig(raw: unknown): AppConfig {
  const r = ConfigSchema.safeParse(raw);
  if (!r.success) throw formatZodError('config.yaml', r.error);
  return r.data;
}

export function parseAliases(raw: unknown): Aliases {
  const r = AliasesSchema.safeParse(raw ?? {});
  if (!r.success) throw formatZodError('aliases.yaml', r.error);
  return r.data;
}

export function loadConfig(rootDir = process.cwd()): LoadedConfig {
  loadDotenv({ path: path.join(rootDir, '.env'), quiet: true });
  const envResult = EnvSchema.safeParse(process.env);
  if (!envResult.success) throw formatZodError('.env', envResult.error);
  const env = envResult.data;
  const cfg = parseConfig(readYaml(path.join(rootDir, 'config.yaml')));
  const aliases = parseAliases(readYaml(path.join(rootDir, 'aliases.yaml')));
  const dbPath = path.resolve(rootDir, env.DB_PATH);
  return { rootDir, env, cfg, aliases, dbPath };
}

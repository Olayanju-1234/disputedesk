import { kvs } from '@forge/kvs';
import { DEFAULT_CONFIG, type AppConfig } from '../domain/ports';
import type { PaystackSecrets } from '../domain/signature';

const CONFIG_KEY = 'settings:config';
const SECRETS_KEY = 'settings:paystack-secrets';

export async function getConfig(): Promise<AppConfig> {
  return { ...DEFAULT_CONFIG, ...(await kvs.get<Partial<AppConfig>>(CONFIG_KEY)) };
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await kvs.set(CONFIG_KEY, config);
}

export async function getPaystackSecrets(): Promise<PaystackSecrets> {
  const stored = await kvs.getSecret<PaystackSecrets>(SECRETS_KEY);
  return { signingSecrets: stored?.signingSecrets ?? [], secretKey: stored?.secretKey };
}

export async function savePaystackSecrets(secrets: PaystackSecrets): Promise<void> {
  await kvs.setSecret(SECRETS_KEY, secrets);
}

export function maskSecret(secret: string | undefined): string | null {
  if (!secret) return null;
  const prefix = secret.match(/^(sk_(?:test|live)_|whsec_)/)?.[0] ?? '';
  return `${prefix}…${secret.slice(-4)}`;
}

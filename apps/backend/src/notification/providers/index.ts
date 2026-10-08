/**
 * Notification providers registry — 1:1 port of providers/__init__.py.
 */
import type { NotificationProvider, ProviderConfig } from '../base';
import { BarkProvider } from './bark';
import { DiscordProvider } from './discord';
import { GotifyProvider } from './gotify';
import { PushoverProvider } from './pushover';
import { ServerChanProvider } from './server-chan';
import { TelegramProvider } from './telegram';
import { WebhookProvider } from './webhook';
import { WecomProvider } from './wecom';

type ProviderCtor = new (config: ProviderConfig) => NotificationProvider;

/** Registry mapping provider type names to their classes. */
export const PROVIDER_REGISTRY: Record<string, ProviderCtor> = {
  telegram: TelegramProvider,
  discord: DiscordProvider,
  bark: BarkProvider,
  'server-chan': ServerChanProvider,
  serverchan: ServerChanProvider, // Alternative name
  wecom: WecomProvider,
  gotify: GotifyProvider,
  pushover: PushoverProvider,
  webhook: WebhookProvider,
};

export {
  BarkProvider,
  DiscordProvider,
  GotifyProvider,
  PushoverProvider,
  ServerChanProvider,
  TelegramProvider,
  WebhookProvider,
  WecomProvider,
};

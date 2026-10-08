/**
 * Discord notification provider — 1:1 port of providers/discord.py.
 */
import { Logger } from '@nestjs/common';

import { expandEnv } from '../../utils/env';
import {
  NotificationProvider,
  type Notification,
  type ProviderConfig,
} from '../base';

const logger = new Logger('DiscordProvider');

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  thumbnail?: { url: string };
}

export class DiscordProvider extends NotificationProvider {
  private readonly webhookUrl: string;

  constructor(config: ProviderConfig) {
    super(config);
    this.webhookUrl = expandEnv(config.webhook_url);
  }

  /** Send notification via Discord webhook. */
  async send(notification: Notification): Promise<boolean> {
    // A configured template overrides the description only; the default
    // (no template) description is kept byte-for-byte for existing configs.
    const description = this.template
      ? this.formatMessage(notification)
      : `**季度:** 第${notification.season}季\n` +
        `**集数:** 第${notification.episode}集`;
    const embed: DiscordEmbed = {
      title: `📺 ${notification.official_title}`,
      description,
      color: 0x00bfff, // Deep Sky Blue
    };

    // Add poster as thumbnail if a public poster URL is available
    const posterUrl = this.posterUrl(notification);
    if (posterUrl) {
      embed.thumbnail = { url: posterUrl };
    }

    const data = {
      embeds: [embed],
    };

    const resp = await this.postJson(this.webhookUrl, data);
    // Python: logger.debug(..., resp.status_code) 对 None 抛 AttributeError，
    // 由 manager 的 guarded 捕获；resp!.status 对 null 抛 TypeError，同理。
    logger.debug(`Discord notification: ${resp!.status}`);
    return resp!.status === 200 || resp!.status === 204;
  }

  /** Test Discord webhook by sending a test message. */
  async test(): Promise<[boolean, string]> {
    const embed: DiscordEmbed = {
      title: 'AutoBangumi 通知测试',
      description: '通知测试成功！\nNotification test successful!',
      color: 0x00ff00, // Green
    };
    const data = { embeds: [embed] };

    try {
      const resp = await this.postJson(this.webhookUrl, data);
      if (resp!.status === 200 || resp!.status === 204) {
        return [true, 'Discord test message sent successfully'];
      } else {
        return [false, `Discord API returned status ${resp!.status}`];
      }
    } catch (e) {
      return [false, `Discord test failed: ${e}`];
    }
  }

  /** Deliver a system event via Discord webhook. */
  protected async deliverText(title: string, body: string): Promise<boolean> {
    const embed: DiscordEmbed = { title, description: body, color: 0xffa500 }; // Orange
    const resp = await this.postJson(this.webhookUrl, { embeds: [embed] });
    return resp!.status === 200 || resp!.status === 204;
  }
}

/**
 * Gotify notification provider — 1:1 port of providers/gotify.py.
 */
import { Logger } from '@nestjs/common';

import { expandEnv } from '../../utils/env';
import {
  NotificationProvider,
  type Notification,
  type ProviderConfig,
} from '../base';

const logger = new Logger('GotifyProvider');

interface GotifyExtras {
  'client::display': { contentType: string };
  'client::notification'?: { bigImageUrl: string };
}

export class GotifyProvider extends NotificationProvider {
  private readonly token: string;
  private readonly notificationUrl: string;

  constructor(config: ProviderConfig) {
    super(config);
    // Python: config.server_url.rstrip("/")（无默认值回退，空串原样保留）
    const serverUrl = expandEnv(config.server_url).replace(/\/+$/, '');
    this.token = expandEnv(config.token);
    this.notificationUrl = `${serverUrl}/message?token=${this.token}`;
  }

  /** Send notification via Gotify. */
  async send(notification: Notification): Promise<boolean> {
    const message = this.formatMessage(notification);

    // Build extras for markdown support and image
    const extras: GotifyExtras = {
      'client::display': { contentType: 'text/markdown' },
    };

    const posterUrl = this.posterUrl(notification);
    if (posterUrl) {
      extras['client::notification'] = {
        bigImageUrl: posterUrl,
      };
    }

    const data = {
      title: notification.official_title,
      message: message,
      priority: 5,
      extras: extras,
    };

    const resp = await this.postJson(this.notificationUrl, data);
    // Python 对 None 抛 AttributeError 由 manager 捕获；resp!.status 同理。
    logger.debug(`Gotify notification: ${resp!.status}`);
    return resp!.status === 200;
  }

  /** Test Gotify configuration by sending a test message. */
  async test(): Promise<[boolean, string]> {
    const data = {
      title: 'AutoBangumi 通知测试',
      message: '通知测试成功！\nNotification test successful!',
      priority: 5,
    };
    try {
      const resp = await this.postJson(this.notificationUrl, data);
      if (resp!.status === 200) {
        return [true, 'Gotify test message sent successfully'];
      } else {
        return [false, `Gotify API returned status ${resp!.status}`];
      }
    } catch (e) {
      return [false, `Gotify test failed: ${e}`];
    }
  }

  /** Deliver a system event via Gotify. */
  protected async deliverText(title: string, body: string): Promise<boolean> {
    const data = { title, message: body, priority: 5 };
    const resp = await this.postJson(this.notificationUrl, data);
    return resp!.status === 200;
  }
}

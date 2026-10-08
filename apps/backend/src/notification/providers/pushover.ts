/**
 * Pushover notification provider — 1:1 port of providers/pushover.py.
 */
import { Logger } from '@nestjs/common';

import { expandEnv } from '../../utils/env';
import {
  NotificationProvider,
  type Notification,
  type ProviderConfig,
} from '../base';

const logger = new Logger('PushoverProvider');

export class PushoverProvider extends NotificationProvider {
  private static readonly API_URL = 'https://api.pushover.net/1/messages.json';

  private readonly userKey: string;
  private readonly apiToken: string;

  constructor(config: ProviderConfig) {
    super(config);
    this.userKey = expandEnv(config.user_key);
    this.apiToken = expandEnv(config.api_token);
  }

  /** Send notification via Pushover. */
  async send(notification: Notification): Promise<boolean> {
    const message = this.formatMessage(notification);

    const data: Record<string, string> = {
      token: this.apiToken,
      user: this.userKey,
      title: notification.official_title,
      message: message,
      html: '0',
    };

    // Add poster as supplementary URL if available
    // （Python 直接放本地 poster_path 而非公网 URL——保持原样）
    if (
      notification.poster_path &&
      notification.poster_path !== 'https://mikanani.me'
    ) {
      data['url'] = notification.poster_path;
      data['url_title'] = '查看海报';
    }

    const resp = await this.postData(PushoverProvider.API_URL, data);
    // Python 对 None 抛 AttributeError 由 manager 捕获；resp!.status 同理。
    logger.debug(`Pushover notification: ${resp!.status}`);
    return resp!.status === 200;
  }

  /** Test Pushover configuration by sending a test message. */
  async test(): Promise<[boolean, string]> {
    const data = {
      token: this.apiToken,
      user: this.userKey,
      title: 'AutoBangumi 通知测试',
      message: '通知测试成功！\nNotification test successful!',
    };
    try {
      const resp = await this.postData(PushoverProvider.API_URL, data);
      if (resp!.status === 200) {
        return [true, 'Pushover test message sent successfully'];
      } else {
        // Try to parse error message from response
        try {
          const errorData = resp!.json<{ errors?: unknown[] }>();
          const errors = errorData.errors ?? [];
          if (errors.length) {
            // Python: f"Pushover error: {', '.join(errors)}"
            return [false, `Pushover error: ${errors.join(', ')}`];
          }
        } catch {
          // pass
        }
        return [false, `Pushover API returned status ${resp!.status}`];
      }
    } catch (e) {
      return [false, `Pushover test failed: ${e}`];
    }
  }

  /** Deliver a system event via Pushover. */
  protected async deliverText(title: string, body: string): Promise<boolean> {
    const data = {
      token: this.apiToken,
      user: this.userKey,
      title: title,
      message: body,
    };
    const resp = await this.postData(PushoverProvider.API_URL, data);
    return resp!.status === 200;
  }
}

/**
 * Bark notification provider — 1:1 port of providers/bark.py.
 */
import { Logger } from '@nestjs/common';

import { expandEnv } from '../../utils/env';
import {
  NotificationProvider,
  type Notification,
  type ProviderConfig,
} from '../base';

const logger = new Logger('BarkProvider');

const DEFAULT_SERVER = 'https://api.day.app';

export class BarkProvider extends NotificationProvider {
  private readonly deviceKey: string;
  private readonly notificationUrl: string;

  constructor(config: ProviderConfig) {
    super(config);
    // Support both legacy token field and new device_key field
    this.deviceKey = expandEnv(config.device_key) || expandEnv(config.token);
    const serverUrl = expandEnv(config.server_url) || DEFAULT_SERVER;
    // Python: f"{server_url.rstrip('/')}/push"
    this.notificationUrl = `${serverUrl.replace(/\/+$/, '')}/push`;
  }

  /** Send notification via Bark. */
  async send(notification: Notification): Promise<boolean> {
    const text = this.formatMessage(notification);
    const data: Record<string, unknown> = {
      title: notification.official_title,
      body: text,
      device_key: this.deviceKey,
    };
    const posterUrl = this.posterUrl(notification);
    if (posterUrl) {
      data['icon'] = posterUrl;
    }

    const resp = await this.postJson(this.notificationUrl, data);
    // Python 对 None 抛 AttributeError 由 manager 捕获；resp!.status 同理。
    logger.debug(`Bark notification: ${resp!.status}`);
    return resp!.status === 200;
  }

  /** Test Bark configuration by sending a test notification. */
  async test(): Promise<[boolean, string]> {
    const data = {
      title: 'AutoBangumi',
      body: '通知测试成功！\nNotification test successful!',
      device_key: this.deviceKey,
    };
    try {
      const resp = await this.postJson(this.notificationUrl, data);
      if (resp!.status === 200) {
        return [true, 'Bark test notification sent successfully'];
      } else {
        return [false, `Bark API returned status ${resp!.status}`];
      }
    } catch (e) {
      return [false, `Bark test failed: ${e}`];
    }
  }

  /** Deliver a system event via Bark. */
  protected async deliverText(title: string, body: string): Promise<boolean> {
    const data = { title, body, device_key: this.deviceKey };
    const resp = await this.postJson(this.notificationUrl, data);
    return resp!.status === 200;
  }
}

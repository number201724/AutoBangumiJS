/**
 * WeChat Work (企业微信) notification provider — 1:1 port of providers/wecom.py.
 */
import { Logger } from '@nestjs/common';

import { expandEnv } from '../../utils/env';
import {
  NotificationProvider,
  type Notification,
  type ProviderConfig,
} from '../base';

const logger = new Logger('WecomProvider');

export class WecomProvider extends NotificationProvider {
  private readonly notificationUrl: string;
  private readonly token: string;

  constructor(config: ProviderConfig) {
    super(config);
    // Support both webhook_url and legacy chat_id field
    this.notificationUrl =
      expandEnv(config.webhook_url) || expandEnv(config.chat_id);
    this.token = expandEnv(config.token);
  }

  /** Send notification via WeChat Work. */
  async send(notification: Notification): Promise<boolean> {
    const title = `【番剧更新】${notification.official_title}`;
    const msg = this.formatMessage(notification);

    const data: Record<string, string> = {
      key: this.token,
      type: 'news',
      title: title,
      msg: msg,
    };
    const posterUrl = this.posterUrl(notification);
    if (posterUrl) {
      data['picurl'] = posterUrl;
    }

    const resp = await this.postData(this.notificationUrl, data);
    // Python 对 None 抛 AttributeError 由 manager 捕获；resp!.status 同理。
    logger.debug(`Wecom notification: ${resp!.status}`);
    return resp!.status === 200;
  }

  /** Test WeChat Work configuration by sending a test message. */
  async test(): Promise<[boolean, string]> {
    const data = {
      key: this.token,
      type: 'news',
      title: 'AutoBangumi 通知测试',
      msg: '通知测试成功！\nNotification test successful!',
    };
    try {
      const resp = await this.postData(this.notificationUrl, data);
      if (resp!.status === 200) {
        return [true, 'WeChat Work test message sent successfully'];
      } else {
        return [false, `WeChat Work API returned status ${resp!.status}`];
      }
    } catch (e) {
      return [false, `WeChat Work test failed: ${e}`];
    }
  }

  /** Deliver a system event via WeChat Work. */
  protected async deliverText(title: string, body: string): Promise<boolean> {
    const data = { key: this.token, type: 'news', title, msg: body };
    const resp = await this.postData(this.notificationUrl, data);
    return resp!.status === 200;
  }
}

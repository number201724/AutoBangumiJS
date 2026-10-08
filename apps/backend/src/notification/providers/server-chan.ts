/**
 * Server Chan notification provider — 1:1 port of providers/server_chan.py.
 */
import { Logger } from '@nestjs/common';

import { expandEnv } from '../../utils/env';
import {
  NotificationProvider,
  type Notification,
  type ProviderConfig,
} from '../base';

const logger = new Logger('ServerChanProvider');

// Server酱³ 的 sendkey 形如 sctp<uid>t<key>，推送端点与 Turbo 版不同 (#904)
const SC3_KEY_RE = /^sctp(\d+)t/;

export class ServerChanProvider extends NotificationProvider {
  private readonly notificationUrl: string;

  constructor(config: ProviderConfig) {
    super(config);
    const token = expandEnv(config.token);
    // Python re.match 自带行首锚定；JS 需要显式 ^
    const sc3 = SC3_KEY_RE.exec(token);
    if (sc3) {
      this.notificationUrl = `https://${sc3[1]}.push.ft07.com/send/${token}.send`;
    } else {
      this.notificationUrl = `https://sctapi.ftqq.com/${token}.send`;
    }
  }

  /** Send notification via Server Chan. */
  async send(notification: Notification): Promise<boolean> {
    const text = this.formatMessage(notification);
    const data = {
      title: notification.official_title,
      desp: text,
    };

    const resp = await this.postData(this.notificationUrl, data);
    // Python 对 None 抛 AttributeError 由 manager 捕获；resp!.status 同理。
    logger.debug(`ServerChan notification: ${resp!.status}`);
    return resp!.status === 200;
  }

  /** Test Server Chan configuration by sending a test message. */
  async test(): Promise<[boolean, string]> {
    const data = {
      title: 'AutoBangumi 通知测试',
      desp: '通知测试成功！\nNotification test successful!',
    };
    try {
      const resp = await this.postData(this.notificationUrl, data);
      if (resp!.status === 200) {
        return [true, 'Server Chan test message sent successfully'];
      } else {
        return [false, `Server Chan API returned status ${resp!.status}`];
      }
    } catch (e) {
      return [false, `Server Chan test failed: ${e}`];
    }
  }

  /** Deliver a system event via Server Chan. */
  protected async deliverText(title: string, body: string): Promise<boolean> {
    const data = { title, desp: body };
    const resp = await this.postData(this.notificationUrl, data);
    return resp!.status === 200;
  }
}

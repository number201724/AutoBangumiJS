/**
 * Telegram notification provider — 1:1 port of providers/telegram.py.
 */
import { Logger } from '@nestjs/common';

import { loadImage, loadPosterUrl } from '../../utils/cache-image';
import { expandEnv } from '../../utils/env';
import {
  NotificationProvider,
  type Notification,
  type ProviderConfig,
} from '../base';

const logger = new Logger('TelegramProvider');

export class TelegramProvider extends NotificationProvider {
  private readonly chatId: string;
  private readonly photoUrl: string;
  private readonly messageUrl: string;

  constructor(config: ProviderConfig) {
    super(config);
    const token = expandEnv(config.token);
    this.chatId = expandEnv(config.chat_id);
    this.photoUrl = `https://api.telegram.org/bot${token}/sendPhoto`;
    this.messageUrl = `https://api.telegram.org/bot${token}/sendMessage`;
  }

  /** Send notification via Telegram. */
  async send(notification: Notification): Promise<boolean> {
    const text = this.formatMessage(notification);
    const data: Record<string, string> = {
      chat_id: this.chatId,
      caption: text,
      text: text,
      // Python httpx 表单编码布尔值为 "true"/"false"（primitive_value_to_str）
      disable_notification: 'true',
    };

    // 发图优先级：源 URL（Telegram 服务端拉图）→ 本地缓存 multipart 上传。
    // 任一失败都降级发纯文本，通知内容不能因海报问题丢失（#1094）。
    let resp = null;
    const photoUrl = await loadPosterUrl(notification.poster_path);
    if (photoUrl) {
      resp = await this.postData(this.photoUrl, { ...data, photo: photoUrl });
    }
    if (resp === null || resp.status !== 200) {
      const photo = await loadImage(notification.poster_path);
      if (photo) {
        // httpx files={"photo": <bytes>} 的 multipart filename 固定为 "upload"
        resp = await this.postFiles(this.photoUrl, data, {
          photo: { filename: 'upload', content: photo },
        });
      }
    }
    if (resp === null || resp.status !== 200) {
      if (resp !== null) {
        logger.warn(
          `Telegram sendPhoto failed (status ${resp.status}), falling back to text.`,
        );
      }
      resp = await this.postData(this.messageUrl, data);
    }

    if (resp === null) {
      return false;
    }
    logger.debug(`Telegram notification: ${resp.status}`);
    return resp.status === 200;
  }

  /** Test Telegram configuration by sending a test message. */
  async test(): Promise<[boolean, string]> {
    const data = {
      chat_id: this.chatId,
      text: 'AutoBangumi 通知测试成功！\nNotification test successful!',
    };
    try {
      const resp = await this.postData(this.messageUrl, data);
      // Python 直接访问 resp.status_code：连接失败返回 None 时抛
      // AttributeError 走 except 分支；resp!.status 对 null 抛 TypeError，同理。
      if (resp!.status === 200) {
        return [true, 'Telegram test message sent successfully'];
      } else {
        return [false, `Telegram API returned status ${resp!.status}`];
      }
    } catch (e) {
      return [false, `Telegram test failed: ${e}`];
    }
  }

  /** Deliver a system event via Telegram. */
  protected async deliverText(title: string, body: string): Promise<boolean> {
    const data = {
      chat_id: this.chatId,
      text: `${title}\n${body}`,
      disable_notification: 'true',
    };
    const resp = await this.postData(this.messageUrl, data);
    // Python: return resp.status_code == 200（None -> AttributeError 上抛给
    // manager 的 guarded 捕获）；resp!.status 对 null 抛 TypeError，同理。
    return resp!.status === 200;
  }
}

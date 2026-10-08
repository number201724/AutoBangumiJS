/**
 * Generic webhook notification provider — 1:1 port of providers/webhook.py.
 */
import { Logger } from '@nestjs/common';

import { expandEnv } from '../../utils/env';
import {
  NotificationProvider,
  type Notification,
  type ProviderConfig,
} from '../base';

const logger = new Logger('WebhookProvider');

/**
 * Default template for webhook payload.
 * Python: json.dumps({...}, ensure_ascii=False) 的默认分隔符（带空格），
 * 直接写字面量保持逐字节一致。
 */
const DEFAULT_TEMPLATE =
  '{"title": "{{title}}", "season": "{{season}}", "episode": "{{episode}}", "poster_url": "{{poster_url}}"}';

export class WebhookProvider extends NotificationProvider {
  private readonly url: string;

  constructor(config: ProviderConfig) {
    super(config);
    this.url = expandEnv(config.url);
  }

  /**
   * Render the template with notification data.
   *
   * Supported variables:
   * - {{title}} - Anime title
   * - {{season}} - Season number
   * - {{episode}} - Episode number
   * - {{poster_url}} - Poster image URL
   */
  private renderTemplate(notification: Notification): Record<string, unknown> {
    // Python 在 __init__ 里收窄：self.template = config.template or
    // DEFAULT_TEMPLATE（空串同样回退）。TS 基类字段是 string | null，
    // 这里在渲染处等值回退。
    let rendered = this.template || DEFAULT_TEMPLATE;

    // Replace template variables
    const replacements: Array<[string, string]> = [
      ['{{title}}', notification.official_title],
      ['{{season}}', String(notification.season)],
      ['{{episode}}', String(notification.episode)],
      ['{{poster_url}}', this.posterUrl(notification) ?? ''],
    ];

    for (const [pattern, value] of replacements) {
      // Escape special characters for JSON string values
      // （顺序一致：先反斜杠再引号；replaceAll 对应 Python str.replace 全量替换）
      const escapedValue = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      rendered = rendered.replaceAll(pattern, escapedValue);
    }

    try {
      return JSON.parse(rendered) as Record<string, unknown>;
    } catch (e) {
      logger.warn(`Invalid webhook template JSON: ${e}`);
      // Fallback to default structure
      return {
        title: notification.official_title,
        season: notification.season,
        episode: notification.episode,
        poster_url: this.posterUrl(notification) ?? '',
      };
    }
  }

  /** Send notification via generic webhook. */
  async send(notification: Notification): Promise<boolean> {
    const data = this.renderTemplate(notification);

    const resp = await this.postJson(this.url, data);
    // Python 对 None 抛 AttributeError 由 manager 捕获；resp!.status 同理。
    logger.debug(`Webhook notification: ${resp!.status}`);
    // Accept any 2xx status code as success
    return resp!.status >= 200 && resp!.status < 300;
  }

  /** Test webhook by sending a test payload. */
  async test(): Promise<[boolean, string]> {
    const testNotification: Notification = {
      official_title: 'AutoBangumi 通知测试',
      season: 1,
      episode: 1,
      poster_path: '',
    };
    const data = this.renderTemplate(testNotification);

    try {
      const resp = await this.postJson(this.url, data);
      if (resp!.status >= 200 && resp!.status < 300) {
        return [true, 'Webhook test request sent successfully'];
      } else {
        return [false, `Webhook returned status ${resp!.status}`];
      }
    } catch (e) {
      return [false, `Webhook test failed: ${e}`];
    }
  }

  /**
   * Deliver a system event via webhook (fixed minimal JSON shape).
   *
   * System events don't use the user-configured episode template — it
   * expects {{title}}/{{season}}/{{episode}}/{{poster_url}}, which system
   * events don't have.
   */
  protected async deliverText(title: string, body: string): Promise<boolean> {
    const data = { title, message: body };
    const resp = await this.postJson(this.url, data);
    return resp!.status >= 200 && resp!.status < 300;
  }
}

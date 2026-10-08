/**
 * Base class for notification providers — 1:1 port of module/notification/base.py.
 *
 * All notification providers must inherit from this class and implement
 * send() and test(). HTTP delivery is composed via a ``RequestURL``
 * instance (``this.http``) rather than inherited — a provider IS-A
 * notification channel, not an HTTP client.
 */
import { settings } from '../config/settings';
import type { ParsedConfig } from '../config/config.schema';
import { RequestURL, type RawResponse } from '../network/request-url';
import type { SystemEvent } from './events';

/**
 * Provider 配置（module/models/config.py 的 NotificationProvider）。
 * token/chat_id/webhook_url/server_url/device_key/user_key/api_token/url
 * 是原始值——Python 用 property 展开 $VAR，这里在使用处经 expandEnv() 展开。
 */
export type ProviderConfig = ParsedConfig['notification']['providers'][number];

/** 新集数通知（module/models/bangumi.py 的 Notification）。 */
export interface Notification {
  official_title: string;
  season: number;
  /** int | float：总集篇等半集（12.5）在通知里保留小数 (#667) */
  episode: number;
  poster_path: string | null;
}

/** Multipart 文件参数（RequestURL.postForm 的 files 形状）。 */
export type MultipartFiles = Record<
  string,
  { filename: string; content: Buffer; contentType?: string }
>;

export abstract class NotificationProvider {
  protected readonly http = new RequestURL();
  /**
   * 单集通知模板（{{title}}/{{season}}/{{episode}}/{{poster_url}}）；
   * 未设置时 ``formatMessage`` 回退到默认中文文案。
   * 注意：template 字段在 Python 里不做 $VAR 展开，这里同样保持原样。
   */
  protected readonly template: string | null;

  protected constructor(config: ProviderConfig) {
    this.template = config.template ?? null;
  }

  /**
   * Send a notification.
   * Returns true if the notification was sent successfully.
   */
  abstract send(notification: Notification): Promise<boolean>;

  /**
   * Test the notification provider configuration.
   * Returns [success, message].
   */
  abstract test(): Promise<[boolean, string]>;

  /**
   * Send a system event (RSS failure, download failure, offset review).
   *
   * System events use each provider's default title/body delivery
   * (``deliverText``) — the per-episode template only covers
   * {{title}}/{{season}}/{{episode}}/{{poster_url}}, which don't apply here.
   */
  async sendEvent(event: SystemEvent): Promise<boolean> {
    const [title, body] = event.describe();
    return this.deliverText(title, body);
  }

  /** Deliver a plain title + body text message. Backs ``sendEvent``. */
  protected abstract deliverText(title: string, body: string): Promise<boolean>;

  /**
   * Format the per-episode notification message.
   *
   * Uses the provider's configured ``template`` when set, substituting
   * ``{{title}}``/``{{season}}``/``{{episode}}``/``{{poster_url}}``;
   * otherwise falls back to the default Chinese message (existing
   * configs without a template keep this exact text).
   */
  protected formatMessage(notify: Notification): string {
    if (!this.template) {
      return (
        `番剧名称：${notify.official_title}\n` +
        `季度： 第${notify.season}季\n` +
        `更新集数： 第${notify.episode}集`
      );
    }
    const replacements: Array<[string, string]> = [
      ['{{title}}', notify.official_title],
      ['{{season}}', String(notify.season)],
      ['{{episode}}', String(notify.episode)],
      ['{{poster_url}}', this.posterUrl(notify) ?? ''],
    ];
    let rendered = this.template;
    for (const [pattern, value] of replacements) {
      // Python str.replace 替换全部出现；replaceAll(字符串) 语义一致
      rendered = rendered.replaceAll(pattern, value);
    }
    return rendered;
  }

  /**
   * Build a public poster URL from a locally-stored poster path.
   *
   * ``Notification.poster_path`` is a local relative path (e.g.
   * ``posters/<hash>.jpg``), not reachable by external services. It can
   * only be exposed to providers when a public ``base_url`` is
   * configured; otherwise callers must omit the poster field entirely.
   */
  protected posterUrl(notify: Notification): string | null {
    if (!notify.poster_path || notify.poster_path === 'https://mikanani.me') {
      return null;
    }
    const baseUrl = settings.data.notification.base_url;
    if (!baseUrl) {
      return null;
    }
    // Python: f"{base_url.rstrip('/')}/{notify.poster_path}"
    return `${baseUrl.replace(/\/+$/, '')}/${notify.poster_path}`;
  }

  /** Form-encoded POST, delegating to the composed HTTP client. */
  protected postData(
    url: string,
    data: Record<string, string>,
  ): Promise<RawResponse | null> {
    return this.http.postUrl(url, data);
  }

  /** Multipart POST, delegating to the composed HTTP client. */
  protected postFiles(
    url: string,
    data: Record<string, string>,
    files: MultipartFiles,
  ): Promise<RawResponse | null> {
    return this.http.postForm(url, data, files);
  }

  /** POST a JSON payload via ``RequestURL.postJson``. */
  protected postJson(url: string, jsonData: unknown): Promise<RawResponse | null> {
    return this.http.postJson(url, jsonData);
  }
}

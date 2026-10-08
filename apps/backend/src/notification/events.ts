/**
 * 非「新集数」通知的类型化事件负载 — 1:1 port of module/notification/events.py.
 *
 * 刻意与 ``Notification``（base.ts，仅描述「新集数下载完成」）分开：RSS 订阅
 * 失败、下载添加失败、偏移量待确认三类事件携带的字段与集数通知完全无关，硬塞进
 * ``Notification`` 只会制造出没有意义的 season/episode 占位值。
 *
 * 每个事件同时服务两个消费方：
 *
 * - 外部推送（Telegram/Bark 等）：``describe() -> [标题, 正文]`` 渲染中文文案；
 * - 站内通知中心：``kind``/``severity``/``once``/``dedupKey()``/``payload()``
 *   提供结构化字段，前端按 kind + payload 做多语言渲染，describe() 文案作为
 *   未知 kind 的兜底展示。``once=true`` 表示同 dedupKey 终生只入库一次
 *   （如"新版本可用"，已读后同一版本不再提醒）。
 *
 * 字段名保持 Python 的 snake_case（payload 键是前端契约），方法名按仓库
 * TS 约定转 camelCase（dedup_key -> dedupKey）。
 */

/** RSS 订阅连接状态从正常变为异常（仅状态翻转时触发一次，而非每个 tick）。 */
export class RssFailureEvent {
  readonly kind = 'rss_failure';
  readonly severity = 'error';
  readonly once = false;

  constructor(
    public readonly rss_name: string,
    public readonly rss_url: string,
    public readonly error: string,
  ) {}

  dedupKey(): string | null {
    return `rss_failure:${this.rss_url}`;
  }

  payload(): Record<string, unknown> {
    return { rss_name: this.rss_name, rss_url: this.rss_url, error: this.error };
  }

  /** 返回该事件的默认 [标题, 正文]。 */
  describe(): [string, string] {
    return [
      'RSS 订阅连接异常',
      `订阅：${this.rss_name}\n地址：${this.rss_url}\n错误：${this.error}`,
    ];
  }
}

/** 匹配到的种子在（内置 HTTP 重试后）仍添加下载器失败。 */
export class DownloadFailureEvent {
  readonly kind = 'download_failure';
  readonly severity = 'error';
  readonly once = false;

  constructor(
    public readonly official_title: string,
    public readonly torrent_name: string,
  ) {}

  dedupKey(): string | null {
    return `download_failure:${this.official_title}`;
  }

  payload(): Record<string, unknown> {
    return {
      official_title: this.official_title,
      torrent_name: this.torrent_name,
    };
  }

  describe(): [string, string] {
    return [
      '种子添加失败',
      `番剧：${this.official_title}\n种子：${this.torrent_name}\n` +
        '重试后仍添加失败，请检查下载器连接。',
    ];
  }
}

/** 番剧被标记为需要人工确认季度/集数偏移。 */
export class OffsetReviewEvent {
  readonly kind = 'offset_review';
  readonly severity = 'warning';
  readonly once = false;

  constructor(
    public readonly official_title: string,
    public readonly reason: string,
  ) {}

  dedupKey(): string | null {
    return `offset_review:${this.official_title}`;
  }

  payload(): Record<string, unknown> {
    return { official_title: this.official_title, reason: this.reason };
  }

  describe(): [string, string] {
    return [
      '集数偏移待确认',
      `番剧：${this.official_title}\n原因：${this.reason}\n请前往设置页确认偏移量。`,
    ];
  }
}

/**
 * 下载器不可用：连不上、用户名/密码错误或 IP 被封禁。
 *
 * ``reason`` 只进 payload 不进 dedupKey——同一台下载器从 unreachable 翻转
 * 到 credentials 时合并为一条（内容以最新为准），不产生两行。
 */
export class DownloaderUnavailableEvent {
  readonly kind = 'downloader_unavailable';
  readonly severity = 'error';
  readonly once = false;

  constructor(
    public readonly host: string,
    /** unreachable | credentials | banned */
    public readonly reason: string,
  ) {}

  dedupKey(): string | null {
    return `downloader:${this.host}`;
  }

  payload(): Record<string, unknown> {
    return { host: this.host, reason: this.reason };
  }

  describe(): [string, string] {
    const details: Record<string, string> = {
      credentials: '用户名或密码错误，请在设置中检查下载器凭据。',
      banned: 'IP 已被下载器封禁，请在下载器 WebUI 中解封或重启下载器。',
      unreachable: '无法连接下载器，请检查地址、端口和网络。',
    };
    const detail = details[this.reason] ?? details['unreachable']!;
    return ['下载器连接异常', `下载器：${this.host}\n${detail}`];
  }
}

/** 检查到可用的新版本。 */
export class UpdateAvailableEvent {
  readonly kind = 'update_available';
  readonly severity = 'info';
  readonly once = true;

  constructor(
    public readonly current: string,
    public readonly latest: string,
    public readonly channel: string,
    public readonly notes = '',
  ) {}

  dedupKey(): string | null {
    return `update_available:${this.latest}`;
  }

  payload(): Record<string, unknown> {
    return {
      current: this.current,
      latest: this.latest,
      channel: this.channel,
      notes: this.notes,
    };
  }

  describe(): [string, string] {
    return [
      '发现新版本',
      `当前版本：${this.current}\n最新版本：${this.latest}（${this.channel} 频道）\n` +
        '可前往 设置 → 软件更新 升级。',
    ];
  }
}

/** 更新应用结果（成功或失败）。每次结果都单独入库，不做去重。 */
export class UpdateAppliedEvent {
  readonly once = false;

  constructor(
    public readonly version: string,
    public readonly success: boolean,
    public readonly message = '',
  ) {}

  get kind(): string {
    return this.success ? 'update_applied' : 'update_failed';
  }

  get severity(): string {
    return this.success ? 'info' : 'error';
  }

  dedupKey(): string | null {
    return null;
  }

  payload(): Record<string, unknown> {
    return { version: this.version, message: this.message };
  }

  describe(): [string, string] {
    if (this.success) {
      return ['程序更新完成', `已更新到 ${this.version}，重启后生效。`];
    }
    return ['程序更新失败', `版本：${this.version}\n原因：${this.message}`];
  }
}

/** 订阅类 LLM 提供商凭据失效（刷新失败），需要用户重新连接。 */
export class LLMAuthFailureEvent {
  readonly kind = 'llm_auth_failure';
  readonly severity = 'error';
  readonly once = false;

  constructor(
    public readonly provider_id: string,
    public readonly account_label = '',
    public readonly message = '',
  ) {}

  dedupKey(): string | null {
    return `llm_auth:${this.provider_id}`;
  }

  payload(): Record<string, unknown> {
    return {
      provider_id: this.provider_id,
      account_label: this.account_label,
      message: this.message,
    };
  }

  describe(): [string, string] {
    const account = this.account_label ? `（${this.account_label}）` : '';
    return [
      'LLM 提供商凭据失效',
      `提供商：${this.provider_id}${account}\n${this.message}\n` +
        '请前往 设置 → LLM 解析器 重新连接。',
    ];
  }
}

/** LLM 提供商插件安装失败（下载/签名校验/兼容性）。 */
export class LLMPluginInstallFailedEvent {
  readonly kind = 'llm_plugin_install_failed';
  readonly severity = 'error';
  readonly once = false;

  constructor(
    public readonly plugin_id: string,
    public readonly version = '',
    public readonly message = '',
  ) {}

  dedupKey(): string | null {
    return `llm_plugin_install:${this.plugin_id}`;
  }

  payload(): Record<string, unknown> {
    return {
      plugin_id: this.plugin_id,
      version: this.version,
      message: this.message,
    };
  }

  describe(): [string, string] {
    return [
      'LLM 插件安装失败',
      `插件：${this.plugin_id} ${this.version}\n原因：${this.message}`,
    ];
  }
}

/** A media rename reached a durable target-path conflict. */
export class RenameConflictEvent {
  readonly kind = 'rename_conflict';
  readonly severity = 'warning';
  readonly once = false;

  constructor(
    public readonly task_id: string,
    public readonly torrent_name: string,
    public readonly target_path: string,
    public readonly reason: string,
  ) {}

  dedupKey(): string | null {
    return `rename_conflict:${this.task_id}:${this.target_path}`;
  }

  payload(): Record<string, unknown> {
    return {
      task_id: this.task_id,
      torrent_name: this.torrent_name,
      target_path: this.target_path,
      reason: this.reason,
    };
  }

  describe(): [string, string] {
    return [
      '媒体文件重命名冲突',
      `种子：${this.torrent_name}\n目标：${this.target_path}\n` +
        `原因：${this.reason}`,
    ];
  }
}

/** 除「新集数」以外的通知事件的联合类型。 */
export type SystemEvent =
  | RssFailureEvent
  | DownloadFailureEvent
  | OffsetReviewEvent
  | DownloaderUnavailableEvent
  | UpdateAvailableEvent
  | UpdateAppliedEvent
  | LLMAuthFailureEvent
  | LLMPluginInstallFailedEvent
  | RenameConflictEvent;

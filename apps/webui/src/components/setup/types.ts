/** 首启向导共享类型 — 对应 Vue 版 store/setup.ts 中的表单数据与校验状态。 */

export interface AccountData {
  username: string;
  password: string;
  confirmPassword: string;
}

export interface DownloaderData {
  type: string;
  host: string;
  username: string;
  password: string;
  path: string;
  ssl: boolean;
}

export interface RssData {
  url: string;
  name: string;
  skipped: boolean;
}

export interface NotificationData {
  enable: boolean;
  type: string;
  token: string;
  chat_id: string;
  skipped: boolean;
}

/** 各连接/订阅源/通知测试的结果（message_zh 优先）。 */
export interface TestOutcome {
  success: boolean;
  message: string;
}

/**
 * LLM provider adapter contracts — mirrors module/parser/analyser/providers/base.py.
 *
 * 一个提供商 = 一个 `LLMProviderAdapter` 子类：负责客户端构造、
 * `parse`/`listModels`，以及（订阅类提供商）认证流程钩子。内置三家与
 * 国产预设走 api_key；订阅插件（device_code/oauth）另行实现认证钩子。
 */
import type { AxiosInstance } from 'axios';

/** 提供商静态描述，驱动前端表单与注册表列举。 */
export interface ProviderInfo {
  id: string;
  display_name: string;
  auth_kind: 'api_key' | 'oauth' | 'device_code';
  builtin: boolean;
  needs_base_url: boolean;
  preset_base_url: string;
  default_model: string;
  /**
   * OpenAI 兼容端点是否支持 json_schema 结构化输出；false 时降级为
   * json_object + schema 写入提示词（DeepSeek/MiniMax）。
   */
  supports_json_schema: boolean;
  plugin_version: string | null;
}

/** begin_auth 的产物：引导用户完成授权所需的全部信息。 */
export interface AuthChallenge {
  method: 'redirect_paste' | 'device_code';
  authorize_url: string | null;
  user_code: string | null;
  verification_uri: string | null;
  expires_in: number;
  state: string;
}

/** 一次成功认证得到的凭据集（服务端持久化，永不下发前端）。 */
export interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number | null;
  account_label: string;
  extra: Record<string, unknown>;
}

export function emptyTokenSet(): TokenSet {
  return {
    access_token: '',
    refresh_token: '',
    expires_at: null,
    account_label: '',
    extra: {},
  };
}

/** 凭据失效且刷新失败——调用方应立即熔断并通知用户重新连接。 */
export class AuthExpiredError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'AuthExpiredError';
  }
}

/** 凭据存取通道（providers/credentials.ts 的 CredentialStore 契约）。 */
export interface CredentialChannel {
  load(): TokenSet | null;
  save(tokens: TokenSet): void;
  clear(): void;
}

/** 适配器可触达的全部依赖（除此之外不读全局配置）。 */
export interface AdapterContext {
  model: string;
  api_key: string;
  base_url: string;
  timeout: number;
  /**
   * llm.buildHttpClient——代理感知的 axios 客户端工厂（对应 Python 注入的
   * _build_http_client，保持同样的依赖注入形状）。
   */
  build_http_client: (timeout: number) => AxiosInstance;
  /** M3 起为 CredentialStore；api_key 类适配器恒为 null。 */
  credentials: CredentialChannel | null;
}

export function makeAdapterContext(
  init: Partial<AdapterContext> & { model: string },
): AdapterContext {
  return {
    api_key: '',
    base_url: '',
    timeout: 20.0,
    build_http_client: () => {
      throw new Error('build_http_client not provided');
    },
    credentials: null,
    ...init,
  };
}

/** 提供商适配器基类（Python ABC 的 TS 等价）。 */
export abstract class LLMProviderAdapter {
  /** 静态描述；子类覆写（Python 的 ClassVar[ProviderInfo]）。 */
  static declare readonly info: ProviderInfo;

  readonly model: string;

  constructor(protected readonly ctx: AdapterContext) {
    // 模型留空时回退到本提供商的默认型号（预设/插件各有自己的默认，
    // 不会误用 openai 的 gpt-5-mini）。
    this.model = ctx.model || (this.constructor as unknown as AdapterClass).info.default_model;
  }

  /** 实例侧读取子类静态 info（对应 Python 的 self.info）。 */
  get info(): ProviderInfo {
    return (this.constructor as unknown as AdapterClass).info;
  }

  /** 解析种子标题为 Episode 形状 dict；失败返回 null。 */
  abstract parse(raw: string): Promise<Record<string, unknown> | null>;

  /** 列出可用模型 id（升序）。 */
  abstract listModels(): Promise<string[]>;

  /** axios 客户端无需显式关闭（连接池由 agent 托管），保留接口对齐。 */
  async aclose(): Promise<void> {
    // no-op for axios（Python 侧关闭 httpx.AsyncClient）
  }

  // ------------------------------------------------------------ auth hooks
  // 仅 oauth / device_code 适配器覆写；api_key 类默认不支持。

  async beginAuth(): Promise<AuthChallenge> {
    throw new Error(`${this.info.id} does not support interactive auth`);
  }

  async completeAuth(_state: string, _userInput = ''): Promise<TokenSet> {
    throw new Error(`${this.info.id} does not support interactive auth`);
  }

  async refresh(_tokens: TokenSet): Promise<TokenSet> {
    throw new Error(`${this.info.id} does not support token refresh`);
  }

  /** 注销远端凭据，尽力而为；默认无操作。 */
  async revoke(_tokens: TokenSet): Promise<void> {}
}

/** 适配器构造器类型（注册表存储形态）。 */
export type AdapterClass = (new (ctx: AdapterContext) => LLMProviderAdapter) & {
  readonly info: ProviderInfo;
};

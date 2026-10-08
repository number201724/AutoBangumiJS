/**
 * 多提供商 LLM 标题解析器（门面）。
 * 1:1 移植 module/parser/analyser/llm.py。
 *
 * 具体提供商逻辑在 ``providers/`` 包中（内置 openai/anthropic/gemini 适配器
 * + 注册表）；本模块保留三样东西以维持既有 patch/import 路径：
 *
 * - ``buildHttpClient``：代理感知的 axios 客户端工厂（对应 Python 的
 *   httpx.AsyncClient 工厂 _build_http_client）；
 * - ``EPISODE_JSON_SCHEMA``/``DEFAULT_PROMPT`` 等共享契约的重导出
 *   （物理定义在 providers/schema.ts）；
 * - ``LLMParser``：构造签名不变的薄门面。
 */
import { Logger } from '@nestjs/common';
import axios, { type AxiosInstance, type AxiosProxyConfig } from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';

import { settings } from '../config/settings';
import { LLMProviderAdapter, makeAdapterContext } from './providers/base';
import { CredentialStore } from './providers/credentials';
import { registry } from './providers/registry';
import {
  DEFAULT_PROMPT,
  EPISODE_JSON_SCHEMA,
  GEMINI_JSON_INSTRUCTION,
  episodeFromDict,
  type LlmEpisode,
} from './providers/schema';

const logger = new Logger('LLMParser');

// 共享契约的重导出（外部 import 路径保持 llm.py 形状）
export {
  DEFAULT_PROMPT,
  EPISODE_JSON_SCHEMA,
  GEMINI_JSON_INSTRUCTION,
  episodeFromDict,
  type LlmEpisode,
};
export { AuthExpiredError } from './providers/base';

/**
 * 代理感知的 axios 客户端工厂（对应 Python 的
 * ``httpx.Timeout(connect=min(t,10), read=t, write=min(t,10), pool=min(t,10))``
 * + follow_redirects；axios 只暴露单一整体超时，取 read 语义）。
 */
export function buildHttpClient(timeout: number): AxiosInstance {
  const instance = axios.create({
    timeout: Math.round(timeout * 1000),
    maxRedirects: 5,
  });
  const proxy = settings.data.proxy;
  if (!proxy.enable) {
    return instance;
  }
  if (proxy.type.includes('http')) {
    const proxyConfig: AxiosProxyConfig = {
      protocol: 'http',
      host: proxy.host,
      port: proxy.port,
    };
    if (proxy.username) {
      proxyConfig.auth = { username: proxy.username, password: proxy.password };
    }
    instance.defaults.proxy = proxyConfig;
    return instance;
  }
  if (proxy.type === 'socks5') {
    const auth = proxy.username
      ? `${proxy.username}:${proxy.password}@`
      : '';
    const agent = new SocksProxyAgent(`socks5://${auth}${proxy.host}:${proxy.port}`);
    instance.defaults.httpAgent = agent;
    instance.defaults.httpsAgent = agent;
    instance.defaults.proxy = false;
  }
  return instance;
}

/** 按 provider 分发的 LLM 标题解析器（适配器门面）。 */
export class LLMParser {
  readonly provider: string;
  readonly model: string;
  private readonly adapter: LLMProviderAdapter;

  /**
   * 初始化解析器并构建对应提供商的适配器。
   *
   * @param apiKey 提供商 API 密钥（api_key 类提供商必填）。
   * @param provider 注册表中的提供商 id。
   * @param model 模型名。
   * @param baseUrl 自定义端点；空串表示官方 API。
   * @param timeout 单次 LLM 请求超时秒数。
   * @throws Error api_key 为空（api_key 类提供商）或 provider 不受支持。
   */
  constructor(
    apiKey: string,
    provider = 'openai',
    model = 'gpt-5-mini',
    baseUrl = '',
    timeout = 20.0,
  ) {
    const AdapterCls = registry.resolve(provider);
    if (AdapterCls.info.auth_kind === 'api_key' && !apiKey) {
      throw new Error('API key is required.');
    }
    this.provider = provider;
    this.model = model;
    this.adapter = new AdapterCls(
      makeAdapterContext({
        model,
        api_key: apiKey,
        base_url: baseUrl,
        timeout,
        build_http_client: buildHttpClient,
        // 订阅类适配器 parse/listModels 时读取凭据；api_key 类忽略。
        credentials: new CredentialStore(provider),
      }),
    );
  }

  async aclose(): Promise<void> {
    await this.adapter.aclose();
  }

  /** 列出当前提供商可用的模型 id（升序）。HTTP 异常原样抛出。 */
  async listModels(): Promise<string[]> {
    return this.adapter.listModels();
  }

  /**
   * 解析种子标题，返回 Episode 形状的 dict；失败返回 null。
   *
   * @param raw 待解析的原始标题。
   * @param _asdict 保留的兼容参数，结果始终为 dict（或 null）。
   */
  async parse(raw: string, _asdict = true): Promise<Record<string, unknown> | null> {
    const result = await this.adapter.parse(raw);
    logger.debug(`LLM(${this.provider}) parsed result: ${JSON.stringify(result)}`);
    return result;
  }
}

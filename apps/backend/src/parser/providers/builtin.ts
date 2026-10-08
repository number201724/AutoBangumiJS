/**
 * 内置三家提供商适配器（openai / anthropic / gemini，API-Key 直连）。
 * 1:1 移植 module/parser/analyser/providers/builtin.py。
 *
 * Python 用官方 SDK；TS 版直接用 axios 调 REST API（OpenAI
 * chat/completions 的 response_format json_schema 或 json_object 降级、
 * Anthropic /v1/messages、Gemini generateContent 的 response_mime_type
 * application/json），保持请求语义一致。
 */
import { Logger } from '@nestjs/common';
import type { AxiosInstance } from 'axios';

import { AdapterContext, LLMProviderAdapter, ProviderInfo } from './base';
import {
  DEFAULT_PROMPT,
  EPISODE_JSON_SCHEMA,
  GEMINI_JSON_INSTRUCTION,
  EPISODE_KEYS,
  episodeFromDict,
} from './schema';

const logger = new Logger('LLMBuiltin');

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null; refusal?: string | null };
  }>;
}

interface ModelsListResponse {
  data?: Array<{ id?: string }>;
}

interface AnthropicMessagesResponse {
  stop_reason?: string | null;
  content?: Array<{ type?: string; text?: string }>;
}

interface AnthropicModelsResponse {
  data?: Array<{ id?: string }>;
}

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

interface GeminiModelsResponse {
  models?: Array<{
    name?: string;
    supportedGenerationMethods?: string[];
  }>;
}

/** 任意 OpenAI 兼容端点（官方 API、DeepSeek、Ollama、OneAPI 等）。 */
export class OpenAIAdapter extends LLMProviderAdapter {
  static override readonly info: ProviderInfo = {
    id: 'openai',
    display_name: 'OpenAI',
    auth_kind: 'api_key',
    builtin: true,
    needs_base_url: true,
    preset_base_url: '',
    default_model: 'gpt-5-mini',
    supports_json_schema: true,
    plugin_version: null,
  };

  protected readonly http: AxiosInstance;
  protected readonly apiKey: string;
  protected readonly baseUrl: string;

  constructor(ctx: AdapterContext) {
    super(ctx);
    this.http = ctx.build_http_client(ctx.timeout);
    this.apiKey = ctx.api_key;
    // 配置留空时回退到预设端点（国产提供商预设子类）
    this.baseUrl = (
      ctx.base_url ||
      this.info.preset_base_url ||
      'https://api.openai.com/v1'
    ).replace(/\/+$/, '');
  }

  async parse(raw: string): Promise<Record<string, unknown> | null> {
    if (!this.info.supports_json_schema) {
      return this.parseJsonObject(raw);
    }
    return this.parseStructured(raw);
  }

  protected async parseStructured(raw: string): Promise<Record<string, unknown> | null> {
    let resp: ChatCompletionResponse;
    try {
      const response = await this.http.post<ChatCompletionResponse>(
        `${this.baseUrl}/chat/completions`,
        {
          model: this.model,
          messages: [
            { role: 'system', content: DEFAULT_PROMPT },
            { role: 'user', content: raw },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'episode',
              schema: EPISODE_JSON_SCHEMA,
              strict: true,
            },
          },
          // temperature 置 0，让结果更稳定可复现
          temperature: 0,
        },
        { headers: { Authorization: `Bearer ${this.apiKey}` } },
      );
      resp = response.data;
    } catch (e) {
      logger.warn(`OpenAI parse failed for '${raw}': ${e}`);
      return null;
    }
    const content = resp.choices?.[0]?.message?.content;
    if (!content) {
      logger.warn(`OpenAI returned no parsed content for '${raw}'`);
      return null;
    }
    try {
      // Python 的 openai 路径 Episode(**json).model_dump() 会剥掉多余键
      // （extra=ignore），弱模型多发字段时与 anthropic/gemini 路径行为不同
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const picked = Object.fromEntries(
        EPISODE_KEYS.filter((k) => k in parsed).map((k) => [k, parsed[k]]),
      );
      const episode = episodeFromDict(picked);
      if (episode === null) {
        logger.warn(`OpenAI returned no parsed content for '${raw}'`);
        return null;
      }
      return episode as unknown as Record<string, unknown>;
    } catch (e) {
      logger.warn(`Cannot decode OpenAI output for '${raw}': ${e}`);
      return null;
    }
  }

  /** json_object 模式：schema 写入提示词，响应本地校验为 Episode。 */
  protected async parseJsonObject(raw: string): Promise<Record<string, unknown> | null> {
    let content: string | null | undefined;
    try {
      const response = await this.http.post<ChatCompletionResponse>(
        `${this.baseUrl}/chat/completions`,
        {
          model: this.model,
          messages: [
            {
              role: 'system',
              content: `${DEFAULT_PROMPT}\n${GEMINI_JSON_INSTRUCTION}`,
            },
            { role: 'user', content: raw },
          ],
          response_format: { type: 'json_object' },
          temperature: 0,
        },
        { headers: { Authorization: `Bearer ${this.apiKey}` } },
      );
      content = response.data.choices?.[0]?.message?.content;
    } catch (e) {
      logger.warn(`OpenAI-compatible parse failed for '${raw}': ${e}`);
      return null;
    }
    if (!content) {
      logger.warn(`OpenAI-compatible returned no content for '${raw}'`);
      return null;
    }
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const picked = Object.fromEntries(
        EPISODE_KEYS.filter((k) => k in parsed).map((k) => [k, parsed[k]]),
      );
      const episode = episodeFromDict(picked);
      if (episode === null) {
        logger.warn(`Cannot decode OpenAI-compatible output for '${raw}'`);
        return null;
      }
      return episode as unknown as Record<string, unknown>;
    } catch (e) {
      logger.warn(`Cannot decode OpenAI-compatible output for '${raw}': ${e}`);
      return null;
    }
  }

  async listModels(): Promise<string[]> {
    const response = await this.http.get<ModelsListResponse>(`${this.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    return (response.data.data ?? [])
      .map((m) => m.id ?? '')
      .filter((id) => id)
      .sort();
  }
}

/** Anthropic Claude（官方 API Key）。 */
export class AnthropicAdapter extends LLMProviderAdapter {
  static override readonly info: ProviderInfo = {
    id: 'anthropic',
    display_name: 'Anthropic',
    auth_kind: 'api_key',
    builtin: true,
    needs_base_url: false,
    preset_base_url: '',
    default_model: 'claude-haiku-4-5',
    supports_json_schema: true,
    plugin_version: null,
  };

  private static readonly API_BASE = 'https://api.anthropic.com/v1';
  private static readonly API_VERSION = '2023-06-01';

  private readonly http: AxiosInstance;
  private readonly apiKey: string;

  constructor(ctx: AdapterContext) {
    super(ctx);
    this.http = ctx.build_http_client(ctx.timeout);
    this.apiKey = ctx.api_key;
  }

  private get headers(): Record<string, string> {
    return {
      'x-api-key': this.apiKey,
      'anthropic-version': AnthropicAdapter.API_VERSION,
    };
  }

  async parse(raw: string): Promise<Record<string, unknown> | null> {
    let resp: AnthropicMessagesResponse;
    try {
      const response = await this.http.post<AnthropicMessagesResponse>(
        `${AnthropicAdapter.API_BASE}/messages`,
        {
          model: this.model,
          max_tokens: 1024,
          system: DEFAULT_PROMPT,
          messages: [{ role: 'user', content: raw }],
          output_config: {
            format: { type: 'json_schema', schema: EPISODE_JSON_SCHEMA },
          },
        },
        { headers: this.headers },
      );
      resp = response.data;
    } catch (e) {
      logger.warn(`Anthropic parse failed for '${raw}': ${e}`);
      return null;
    }
    if (resp.stop_reason === 'refusal') {
      logger.warn(`Anthropic refused to parse '${raw}'`);
      return null;
    }
    try {
      const text = (resp.content ?? []).find((b) => b.type === 'text')?.text;
      if (text === undefined) {
        throw new Error('no text block in response');
      }
      return JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      logger.warn(`Cannot decode Anthropic output for '${raw}': ${e}`);
      return null;
    }
  }

  async listModels(): Promise<string[]> {
    const response = await this.http.get<AnthropicModelsResponse>(
      `${AnthropicAdapter.API_BASE}/models`,
      { headers: this.headers },
    );
    return (response.data.data ?? [])
      .map((m) => m.id ?? '')
      .filter((id) => id)
      .sort();
  }
}

/** Google Gemini（AI Studio API Key）。 */
export class GeminiAdapter extends LLMProviderAdapter {
  static override readonly info: ProviderInfo = {
    id: 'gemini',
    display_name: 'Google Gemini',
    auth_kind: 'api_key',
    builtin: true,
    needs_base_url: false,
    preset_base_url: '',
    default_model: 'gemini-2.5-flash',
    supports_json_schema: true,
    plugin_version: null,
  };

  private static readonly API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

  private readonly http: AxiosInstance;
  private readonly apiKey: string;

  constructor(ctx: AdapterContext) {
    super(ctx);
    // Python 的 genai.Client 不走自定义 http client；TS 版统一走代理感知
    // 工厂（请求语义一致）。
    this.http = ctx.build_http_client(ctx.timeout);
    this.apiKey = ctx.api_key;
  }

  async parse(raw: string): Promise<Record<string, unknown> | null> {
    let text: string;
    try {
      const response = await this.http.post<GeminiGenerateResponse>(
        `${GeminiAdapter.API_BASE}/models/${this.model}:generateContent`,
        {
          contents: [
            {
              role: 'user',
              parts: [{ text: `${DEFAULT_PROMPT}\n${GEMINI_JSON_INSTRUCTION}\n\n${raw}` }],
            },
          ],
          generationConfig: { responseMimeType: 'application/json' },
        },
        { headers: { 'x-goog-api-key': this.apiKey } },
      );
      const parts = response.data.candidates?.[0]?.content?.parts ?? [];
      text = parts.map((part) => part.text ?? '').join('');
    } catch (e) {
      logger.warn(`Gemini parse failed for '${raw}': ${e}`);
      return null;
    }
    if (!text) {
      logger.warn(`Gemini returned no text for '${raw}'`);
      return null;
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      logger.warn(`Cannot decode Gemini output for '${raw}': ${e}`);
      return null;
    }
  }

  async listModels(): Promise<string[]> {
    const response = await this.http.get<GeminiModelsResponse>(
      `${GeminiAdapter.API_BASE}/models`,
      { headers: { 'x-goog-api-key': this.apiKey } },
    );
    const ids: string[] = [];
    for (const m of response.data.models ?? []) {
      const actions = m.supportedGenerationMethods;
      if (actions && !actions.includes('generateContent')) {
        continue;
      }
      const name = m.name ?? '';
      ids.push(name.startsWith('models/') ? name.slice('models/'.length) : name);
    }
    return ids.sort();
  }
}

export const BUILTIN: Record<string, typeof OpenAIAdapter | typeof AnthropicAdapter | typeof GeminiAdapter> = {
  openai: OpenAIAdapter,
  anthropic: AnthropicAdapter,
  gemini: GeminiAdapter,
};

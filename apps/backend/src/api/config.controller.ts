/**
 * /api/v1/config — 1:1 port of module/api/config.py, including the
 * mask-restore choreography (the subtle part: list items are matched by
 * identity, never by blind index, so a deleted entry cannot donate its secret
 * to a survivor).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import { settings } from '../config/settings';
import { ConfigSchema, llmEffective } from '../config/config.schema';
import { ZodError } from 'zod';
import { getContext } from '../core/runtime';
import { AuthGuard } from '../security/api';
import { lazyRequire } from '../utils/lazy';

import { Logger } from '@nestjs/common';

const logger = new Logger('ConfigAPI');

const SENSITIVE_KEYS = ['password', 'api_key', 'token', 'secret'];
const MASK = '********';

function isSensitive(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some((s) => lower.includes(s));
}

type JsonObject = Record<string, unknown>;

/** Recursively mask string values whose keys contain sensitive keywords. */
function sanitizeDict(d: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const [k, v] of Object.entries(d)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      result[k] = sanitizeDict(v as JsonObject);
    } else if (Array.isArray(v)) {
      result[k] = v.map((item) =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? sanitizeDict(item as JsonObject)
          : item,
      );
    } else if (typeof v === 'string' && v && isSensitive(k)) {
      // 空值不打掩码：否则未设置密码的字段在前端永远显示一串幻影掩码
      result[k] = MASK;
    } else {
      result[k] = v;
    }
  }
  return result;
}

class MaskRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaskRestoreError';
  }
}

/** 列表项的身份 = 全部非敏感标量字段（敏感侧是掩码，无法参与匹配）。 */
function identity(d: JsonObject): string {
  const entries = Object.entries(d)
    // Python 的 _identity 包含 ('k', None)——null 也是标量，参与身份
    .filter(([k, v]) => (v === null || typeof v !== 'object') && !isSensitive(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

function containsMask(value: unknown): boolean {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) return value.some(containsMask);
    return Object.values(value as JsonObject).some(containsMask);
  }
  return value === MASK;
}

/**
 * 按身份匹配列表项后再恢复各自的掩码密钥。长度未变时视为原地编辑：
 * 同下标同身份 → 唯一身份（识别重排）→ 按下标兜底；长度变了（增/删）
 * 只接受唯一身份匹配，无法唯一定位来源的掩码项直接报错，绝不猜。
 */
function restoreMaskedList(incoming: unknown[], current: unknown[]): void {
  const masked = incoming
    .map((item, i) => [item, i] as const)
    .filter(
      ([item]) =>
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        containsMask(item),
    )
    .map(([, i]) => i);
  if (!masked.length) return;

  const unconsumed = new Set<number>(
    current
      .map((item, j) => [item, j] as const)
      .filter(
        ([item]) => item !== null && typeof item === 'object' && !Array.isArray(item),
      )
      .map(([, j]) => j),
  );
  const matched = new Map<number, number>();

  const matchUniqueIdentity = (i: number): void => {
    const candidates = [...unconsumed].filter(
      (j) =>
        identity(current[j] as JsonObject) === identity(incoming[i] as JsonObject),
    );
    if (candidates.length === 1) {
      matched.set(i, candidates[0]);
      unconsumed.delete(candidates[0]);
    }
  };

  if (incoming.length === current.length) {
    for (const i of masked) {
      if (
        unconsumed.has(i) &&
        identity(incoming[i] as JsonObject) === identity(current[i] as JsonObject)
      ) {
        matched.set(i, i);
        unconsumed.delete(i);
      }
    }
    for (const i of masked) {
      if (!matched.has(i)) matchUniqueIdentity(i);
    }
    for (const i of masked) {
      if (!matched.has(i) && unconsumed.has(i)) {
        matched.set(i, i);
        unconsumed.delete(i);
      }
    }
  } else {
    for (const i of masked) {
      matchUniqueIdentity(i);
    }
  }

  for (const i of masked) {
    const j = matched.get(i);
    if (j !== undefined) {
      restoreMasked(incoming[i] as JsonObject, current[j] as JsonObject);
    } else {
      throw new MaskRestoreError(
        `cannot determine which stored entry list item #${i} refers to; ` +
          're-enter its secret value and save again',
      );
    }
  }
}

/** Replace masked sentinel values with real values from current config. */
function restoreMasked(incoming: JsonObject, current: JsonObject): JsonObject {
  for (const [k, v] of Object.entries(incoming)) {
    const cur = current[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && cur !== null && typeof cur === 'object' && !Array.isArray(cur)) {
      restoreMasked(v as JsonObject, cur as JsonObject);
    } else if (Array.isArray(v) && Array.isArray(cur)) {
      restoreMaskedList(v, cur);
    } else if (v === MASK && isSensitive(k)) {
      incoming[k] = cur ?? v;
    }
  }
  return incoming;
}

@Controller('/api/v1/config')
@UseGuards(AuthGuard)
export class ConfigController {
  /** Return the current configuration with sensitive fields masked. */
  @Get('/get')
  getConfig() {
    return sanitizeDict(settings.dump() as unknown as JsonObject);
  }

  /** Persist and reload configuration from the supplied payload. */
  @Patch('/update')
  async updateConfig(@Body() body: unknown, @Res() res: Response) {
    let parsed: ReturnType<typeof ConfigSchema.parse>;
    try {
      // Validate against the Config model (pydantic parity: unknown keys stripped)
      parsed = ConfigSchema.parse(body ?? {});
    } catch (e) {
      // FastAPI 在进 handler 前对 Config 模型校验失败 → 422
      if (e instanceof ZodError) {
        res.status(422).json({
          detail: e.issues.map((i) => ({
            loc: ['body', ...i.path],
            msg: i.message,
            type: i.code,
          })),
        });
        return;
      }
      throw e;
    }
    try {
      const configDict = restoreMasked(
        JSON.parse(JSON.stringify(parsed)) as JsonObject,
        settings.dump() as unknown as JsonObject,
      );
      settings.save(configDict as unknown as ReturnType<typeof settings.dump>);
      // reload_settings reloads from disk, resets the shared HTTP client,
      // rebuilds notifications, and re-applies the RSS/rename loops.
      await getContext().reloadSettings();
      logger.log('Config updated');
      res.json({ msg_en: 'Update config successfully.', msg_zh: '更新配置成功。' });
    } catch (e) {
      if (e instanceof MaskRestoreError) {
        logger.warn(String(e));
        res.status(400).json({
          msg_en: e.message,
          msg_zh: '无法恢复被掩码的密钥来源，请重新输入该密钥后再保存。',
        });
        return;
      }
      logger.warn(String(e));
      res.status(406).json({ msg_en: 'Update config failed.', msg_zh: '更新配置失败。' });
    }
  }

  /** 拉取所选 LLM 提供商的可用模型列表（掩码密钥回退到已保存值）。 */
  @Post('/llm/models')
  @HttpCode(200)
  async listLlmModels(@Body() req: { provider?: string; api_key?: string; base_url?: string }) {
    const provider = req.provider ?? 'openai';
    let apiKey = req.api_key ?? '';
    if (!apiKey || apiKey === MASK) {
      // 按提供商取已保存密钥（providers[id] 覆盖 → 扁平字段兜底）
      [apiKey] = llmEffective(settings.data.llm, provider);
    }
    if (!apiKey) {
      throw new HttpException('LLM API key is required', 400);
    }
    let parser: { listModels(): Promise<string[]>; aclose(): Promise<void> };
    interface LLMParserCtor {
      new (
        apiKey: string,
        provider?: string,
        model?: string,
        baseUrl?: string,
        timeout?: number,
      ): { listModels(): Promise<string[]>; aclose(): Promise<void> };
    }
    try {
      const { LLMParser } = lazyRequire<{ LLMParser: LLMParserCtor }>('../parser/llm');
      parser = new LLMParser(apiKey, provider, undefined, req.base_url ?? '', 10.0);
    } catch (e) {
      throw new HttpException(String((e as Error).message ?? e), 400);
    }
    try {
      const models: string[] = await parser.listModels();
      return { models };
    } catch (e) {
      logger.warn(`LLM model list fetch failed (${provider}): ${e}`);
      throw new HttpException('Failed to fetch the model list from the provider', 502);
    } finally {
      await parser.aclose();
    }
  }
}

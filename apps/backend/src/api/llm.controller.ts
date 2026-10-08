/**
 * /api/v1/config/llm — 1:1 port of module/api/llm.py.
 *
 * Provider view + subscription auth flow (device_code server-side polling,
 * sensitive state kept server-side). Plugin install/uninstall return 400 in
 * this build (the signed plugin installer is a phase-2 module).
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import * as crypto from 'node:crypto';

import { AuthGuard } from '../security/api';
import { lazyRequire } from '../utils/lazy';

import { Logger } from '@nestjs/common';

const logger = new Logger('LlmAPI');

const PENDING_TTL = 900.0; // seconds

interface PendingAuth {
  providerId: string;
  created: number;
  expires: number;
  /** 适配器 challenge.state（敏感，服务端专用，绝不下发前端） */
  blob: string;
}

const PENDING = new Map<string, PendingAuth>();

function prunePending(now: number): void {
  for (const [state, p] of PENDING) {
    if (p.expires < now) PENDING.delete(state);
  }
}

function llmModules() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { registry, UnknownProviderError } = require('../parser/providers/registry') as typeof import('../parser/providers/registry');
  const { CredentialStore, bumpAuthGeneration } = require('../parser/providers/credentials') as typeof import('../parser/providers/credentials');
  const { makeAdapterContext, AuthExpiredError } = require('../parser/providers/base') as typeof import('../parser/providers/base');
  const { buildHttpClient } = require('../parser/llm') as typeof import('../parser/llm');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { registry, UnknownProviderError, CredentialStore, bumpAuthGeneration, makeAdapterContext, AuthExpiredError, buildHttpClient };
}

function makeAdapter(providerId: string) {
  const { registry, makeAdapterContext, CredentialStore, buildHttpClient } = llmModules();
  const AdapterCls = registry.resolve(providerId);
  const ctx = makeAdapterContext({
    model: AdapterCls.info.default_model,
    build_http_client: buildHttpClient,
    credentials: new CredentialStore(providerId),
  });
  return new AdapterCls(ctx);
}

async function providerStatus(providerId: string) {
  const { CredentialStore } = llmModules();
  const tokens = new CredentialStore(providerId).load();
  if (tokens === null) {
    return { connected: false, account_label: '', expires_at: null };
  }
  return {
    connected: true,
    account_label: tokens.account_label,
    expires_at: tokens.expires_at,
  };
}

function pollInterval(blob: string): number {
  try {
    const n = parseInt(JSON.parse(blob).interval ?? '5', 10);
    // Python int() 失败回退 5s；NaN 会打成 0ms 热循环
    return Number.isNaN(n) ? 5 : Math.max(1, n);
  } catch {
    return 5;
  }
}

/** device flow 服务端轮询：到期前按 interval 反复 complete_auth。 */
async function devicePollLoop(providerId: string, handle: string, expiresIn: number): Promise<void> {
  const { CredentialStore, bumpAuthGeneration, AuthExpiredError } = llmModules();
  const deadline = Date.now() / 1000 + Math.min(expiresIn, PENDING_TTL);
  let adapter;
  try {
    adapter = makeAdapter(providerId);
  } catch {
    PENDING.delete(handle);
    return;
  }
  try {
    while (Date.now() / 1000 < deadline) {
      const pendingBefore = PENDING.get(handle);
      if (!pendingBefore) return; // 被取消 / 已完成 / 断开
      const blob = pendingBefore.blob;
      await new Promise((r) => setTimeout(r, pollInterval(blob) * 1000));
      if (!PENDING.get(handle)) return;
      let tokens;
      try {
        tokens = await adapter.completeAuth(blob);
      } catch (e) {
        if (e instanceof AuthExpiredError) {
          continue; // authorization_pending / slow_down：继续轮询
        }
        logger.warn(`device auth poll failed for ${providerId}: ${e}`);
        continue;
      }
      new CredentialStore(providerId).save(tokens);
      bumpAuthGeneration(providerId);
      PENDING.delete(handle);
      logger.log(`LLM provider ${providerId} connected via device flow`);
      return;
    }
  } finally {
    await adapter.aclose();
    PENDING.delete(handle);
  }
}

@Controller('/api/v1/config/llm')
@UseGuards(AuthGuard)
export class LlmController {
  /** 内置 + 预设 + 已安装插件的合并视图（含连接状态，绝不含 token）。 */
  @Get('/providers')
  async listProviders() {
    const { registry, CredentialStore } = llmModules();
    const infos = registry.listInfos();
    // 订阅类提供商的连接状态批量取
    const statuses = new Map<string, { connected: boolean; account_label: string; expires_at: number | null }>();
    const subscriptionIds = infos.filter((i) => i.auth_kind !== 'api_key').map((i) => i.id);
    for (const pid of subscriptionIds) {
      const tokens = new CredentialStore(pid).load();
      statuses.set(
        pid,
        tokens === null
          ? { connected: false, account_label: '', expires_at: null }
          : { connected: true, account_label: tokens.account_label, expires_at: tokens.expires_at },
      );
    }
    return {
      providers: infos.map((info) => {
        const status = statuses.get(info.id);
        return {
          id: info.id,
          display_name: info.display_name,
          auth_kind: info.auth_kind,
          builtin: info.builtin,
          needs_base_url: info.needs_base_url,
          preset_base_url: info.preset_base_url,
          default_model: info.default_model,
          plugin_version: info.plugin_version,
          connected: status?.connected ?? false,
          account_label: status?.account_label ?? '',
          expires_at: status?.expires_at ?? null,
        };
      }),
    };
  }

  @Post('/providers/:provider_id/install')
  @HttpCode(200)
  async installProvider(@Param('provider_id') providerId: string) {
    // 验签插件安装器为二期模块
    void providerId;
    throw new HttpException('LLM plugin installation is not supported in this build', 400);
  }

  @Delete('/providers/:provider_id')
  async uninstallProvider(@Param('provider_id') providerId: string) {
    void providerId;
    throw new HttpException('LLM plugin uninstallation is not supported in this build', 400);
  }

  @Post('/providers/:provider_id/auth/begin')
  @HttpCode(200)
  async authBegin(@Param('provider_id') providerId: string) {
    let adapter;
    try {
      adapter = makeAdapter(providerId);
    } catch (e) {
      throw new HttpException(String((e as Error).message), 404);
    }
    let challenge;
    try {
      challenge = await adapter.beginAuth();
    } catch (e) {
      if (e instanceof Error && e.name === 'NotImplementedError') {
        throw new HttpException('Provider does not support interactive auth', 400);
      }
      throw e;
    } finally {
      await adapter.aclose();
    }

    // 敏感 blob 存服务端，返回给前端不透明 handle
    const now = Date.now() / 1000;
    prunePending(now);
    const handle = crypto.randomBytes(24).toString('base64url');
    PENDING.set(handle, {
      providerId,
      created: now,
      expires: now + Math.min(challenge.expires_in, PENDING_TTL),
      blob: challenge.state,
    });

    if (challenge.method === 'device_code') {
      // 服务端起轮询任务；前端只轮询 auth/status
      void devicePollLoop(providerId, handle, challenge.expires_in);
    }

    return {
      method: challenge.method,
      authorize_url: challenge.authorize_url,
      user_code: challenge.user_code,
      verification_uri: challenge.verification_uri,
      expires_in: challenge.expires_in,
      state: handle,
    };
  }

  /** redirect_paste 流程：前端回传授权 code；device flow 由服务端轮询完成。 */
  @Post('/providers/:provider_id/auth/complete')
  @HttpCode(200)
  async authComplete(
    @Param('provider_id') providerId: string,
    @Body() req: { state: string; code?: string },
  ) {
    const pending = PENDING.get(req.state);
    if (!pending || pending.providerId !== providerId) {
      throw new HttpException('Unknown or expired auth state', 400);
    }
    let adapter;
    try {
      adapter = makeAdapter(providerId);
    } catch (e) {
      throw new HttpException(String((e as Error).message), 404);
    }
    let tokens;
    try {
      tokens = await adapter.completeAuth(pending.blob, req.code ?? '');
    } catch (e) {
      logger.warn(`LLM auth complete failed for ${providerId}: ${e}`);
      throw new HttpException('Authorization failed', 400);
    } finally {
      await adapter.aclose();
    }
    const { CredentialStore, bumpAuthGeneration } = llmModules();
    new CredentialStore(providerId).save(tokens);
    bumpAuthGeneration(providerId);
    PENDING.delete(req.state);
    return { connected: true, account_label: tokens.account_label };
  }

  @Get('/providers/:provider_id/auth/status')
  async authStatus(@Param('provider_id') providerId: string) {
    return providerStatus(providerId);
  }

  @Delete('/providers/:provider_id/auth')
  async authDisconnect(@Param('provider_id') providerId: string) {
    const { CredentialStore, bumpAuthGeneration } = llmModules();
    const store = new CredentialStore(providerId);
    const tokens = store.load();
    if (tokens !== null) {
      let adapter;
      try {
        adapter = makeAdapter(providerId);
      } catch {
        adapter = null;
      }
      if (adapter !== null) {
        try {
          await adapter.revoke(tokens);
        } catch (e) {
          logger.debug(`revoke best-effort failed for ${providerId}: ${e}`);
        } finally {
          await adapter.aclose();
        }
      }
    }
    store.clear();
    bumpAuthGeneration(providerId);
    return { connected: false };
  }
}

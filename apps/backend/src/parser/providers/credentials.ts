/**
 * 订阅提供商凭据访问 + 进程内 auth generation 计数。
 * 1:1 移植 module/parser/analyser/providers/credentials.py。
 *
 * - ``CredentialStore``：适配器唯一被允许的凭据通道（provider 域内
 *   load/save/clear）；
 * - ``authGeneration``：连接/断开时 bump（静默刷新不 bump），
 *   title_parser 把它掺进单例键实现"换号即重建、刷新不抖动"。
 *   AB 单进程部署，进程内计数即可。
 *
 * Python 端 Database 是 async session-per-operation；TS 端 db 门面为
 * better-sqlite3 同步单写者模型，方法保持同步（行为等价）。
 */
import { db } from '../../database/facade';
import type { CredentialChannel, TokenSet } from './base';

const generations = new Map<string, number>();

export function authGeneration(providerId: string): number {
  return generations.get(providerId) ?? 0;
}

export function bumpAuthGeneration(providerId: string): void {
  generations.set(providerId, authGeneration(providerId) + 1);
}

/** 单一提供商的凭据读写句柄（注入 AdapterContext.credentials）。 */
export class CredentialStore implements CredentialChannel {
  constructor(readonly providerId: string) {}

  load(): TokenSet | null {
    return db.llm_credential.get(this.providerId);
  }

  /** 持久化凭据（含静默刷新——不 bump generation）。 */
  save(tokens: TokenSet): void {
    db.llm_credential.upsert(this.providerId, tokens);
  }

  clear(): void {
    db.llm_credential.delete(this.providerId);
  }
}

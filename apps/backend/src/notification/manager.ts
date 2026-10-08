/**
 * Notification manager for handling multiple providers — 1:1 port of
 * module/notification/manager.py.
 *
 * Python 在 ``async with provider`` 里发送（RequestContent 的 aenter/aexit
 * 绑定/释放共享 httpx client）；TS 的 RequestURL 使用全局共享 axios client
 * （getSharedClient/resetSharedClient），无对应生命周期，故 broadcast 里
 * 没有等价的 context manager 包装。
 */
import { Logger } from '@nestjs/common';

import { settings } from '../config/settings';
import { db } from '../database/facade';
import type { Notification, NotificationProvider, ProviderConfig } from './base';
import type { SystemEvent } from './events';
import { recordEvent } from './inbox';
import { PROVIDER_REGISTRY } from './providers';

const logger = new Logger('NotificationManager');

export class NotificationManager {
  /** Manager for handling notifications across multiple providers. */
  providers: NotificationProvider[] = [];

  constructor() {
    this.loadProviders();
  }

  /**
   * Reload providers from current settings, mutating in place.
   *
   * Called on config reload so the shared instance (captured by the rename
   * loop) picks up provider changes without being re-wired.
   */
  rebuild(): void {
    this.providers = [];
    this.loadProviders();
  }

  /** Initialize providers from configuration. */
  private loadProviders(): void {
    for (const cfg of settings.data.notification.providers) {
      if (!cfg.enabled) {
        continue;
      }

      const ProviderCls = PROVIDER_REGISTRY[cfg.type.toLowerCase()];
      if (ProviderCls) {
        try {
          this.providers.push(new ProviderCls(cfg));
          logger.debug(`Loaded notification provider: ${cfg.type}`);
        } catch (e) {
          logger.warn(`Failed to load provider ${cfg.type}: ${e}`);
        }
      } else {
        logger.warn(`Unknown notification provider type: ${cfg.type}`);
      }
    }
  }

  /** Fetch poster path from database if not already set. */
  private async getPoster(notification: Notification): Promise<void> {
    if (notification.poster_path) {
      return;
    }

    const data = db.bangumi.searchOfficialTitle(notification.official_title);
    if (data) {
      notification.poster_path = data.poster_link;
    }
  }

  /**
   * Run ``sendOne`` against every provider in parallel, logging failures.
   *
   * Shared by ``sendAll`` and ``sendEvent`` so both broadcast the same way:
   * one provider's exception never blocks the others.
   * （Python asyncio.gather -> Promise.allSettled；异常在 guarded 内已捕获。）
   */
  private async broadcast(
    label: string,
    sendOne: (provider: NotificationProvider) => Promise<void>,
  ): Promise<void> {
    if (!this.providers.length) {
      logger.debug('No notification providers configured');
      return;
    }

    const guarded = async (provider: NotificationProvider): Promise<void> => {
      try {
        await sendOne(provider);
      } catch (e) {
        logger.warn(
          `Failed to send ${label} via ${provider.constructor.name}: ${e}`,
        );
      }
    };

    await Promise.allSettled(this.providers.map((p) => guarded(p)));
  }

  /** Send notification to all enabled providers. */
  async sendAll(notification: Notification): Promise<void> {
    if (!this.providers.length) {
      logger.debug('No notification providers configured');
      return;
    }

    // Fetch poster if needed
    await this.getPoster(notification);

    await this.broadcast('notification', async (provider) => {
      await provider.send(notification);
      logger.debug(
        `Sent notification via ${provider.constructor.name}: ${notification.official_title}`,
      );
    });
  }

  /**
   * Persist a system event to the in-app inbox, then broadcast it.
   *
   * 持久化不受 ``settings.notification.enable`` 影响（该开关只管外部
   * 推送），失败也不阻塞外部广播。
   */
  async sendEvent(event: SystemEvent): Promise<void> {
    try {
      recordEvent(event);
    } catch (e) {
      logger.warn(
        `Failed to persist inbox message for ${event.constructor.name}: ` +
          `${(e as Error).stack ?? e}`,
      );
    }
    if (!settings.data.notification.enable) {
      return;
    }

    await this.broadcast('system event', async (provider) => {
      await provider.sendEvent(event);
      logger.debug(
        `Sent system event via ${provider.constructor.name}: ${event.kind}`,
      );
    });
  }

  /** Test a specific provider by index. Returns [success, message]. */
  async testProvider(index: number): Promise<[boolean, string]> {
    if (index < 0 || index >= this.providers.length) {
      return [false, `Invalid provider index: ${index}`];
    }

    const provider = this.providers[index]!;
    try {
      return await provider.test();
    } catch (e) {
      return [false, `Test failed: ${e}`];
    }
  }

  /** Test a provider configuration without saving it. */
  static async testProviderConfig(
    config: ProviderConfig,
  ): Promise<[boolean, string]> {
    const ProviderCls = PROVIDER_REGISTRY[config.type.toLowerCase()];
    if (!ProviderCls) {
      return [false, `Unknown provider type: ${config.type}`];
    }

    try {
      const provider = new ProviderCls(config);
      return await provider.test();
    } catch (e) {
      return [false, `Test failed: ${e}`];
    }
  }

  /** Python ``__len__``. */
  get length(): number {
    return this.providers.length;
  }
}

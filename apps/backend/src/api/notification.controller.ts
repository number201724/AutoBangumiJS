/**
 * /api/v1/notification — 1:1 port of module/api/notification.py
 * (provider test endpoints + in-app inbox CRUD).
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
  Query,
  UseGuards,
} from '@nestjs/common';

import { db } from '../database/facade';
import { NotificationManager } from '../notification/manager';
import { bumpInboxRevision } from '../notification/inbox';
import { AuthGuard } from '../security/api';
import type { NotificationProviderConfig } from '@ab/types';

import { Logger } from '@nestjs/common';
import { StrictIntPipe, parseBoolQuery } from './pipes';

const logger = new Logger('NotificationAPI');

interface TestResponse {
  success: boolean;
  message: string;
  message_zh: string;
  message_en: string;
}

function toOut(m: {
  id: number;
  kind: string;
  severity: string;
  title: string;
  body: string;
  payload: string | null;
  read: boolean;
  count: number;
  created_at: string;
  updated_at: string;
}) {
  let payload: unknown = null;
  if (m.payload) {
    try {
      payload = JSON.parse(m.payload);
    } catch {
      payload = null;
    }
  }
  return {
    id: m.id,
    kind: m.kind,
    severity: m.severity,
    title: m.title,
    body: m.body,
    payload,
    read: m.read,
    count: m.count,
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}

@Controller('/api/v1/notification')
@UseGuards(AuthGuard)
export class NotificationController {
  /** Test a configured notification provider by its index. */
  @Post('/test')
  @HttpCode(200)
  async testProvider(@Body() request: { provider_index: number }): Promise<TestResponse> {
    try {
      const manager = new NotificationManager();
      if (request.provider_index >= manager.length) {
        return {
          success: false,
          message: `Invalid provider index: ${request.provider_index}`,
          message_zh: `无效的提供者索引: ${request.provider_index}`,
          message_en: `Invalid provider index: ${request.provider_index}`,
        };
      }
      const [success, message] = await manager.testProvider(request.provider_index);
      return {
        success,
        message,
        message_zh: success ? '测试成功' : `测试失败: ${message}`,
        message_en: success ? 'Test successful' : `Test failed: ${message}`,
      };
    } catch (e) {
      logger.error(`Failed to test provider: ${e}`);
      return {
        success: false,
        message: String(e),
        message_zh: `测试失败: ${e}`,
        message_en: `Test failed: ${e}`,
      };
    }
  }

  /** Test an unsaved notification provider configuration. */
  @Post('/test-config')
  @HttpCode(200)
  async testProviderConfig(
    @Body() request: NotificationProviderConfig,
  ): Promise<TestResponse> {
    try {
      const config: NotificationProviderConfig = {
        type: request.type,
        enabled: request.enabled ?? true,
        token: request.token || '',
        chat_id: request.chat_id || '',
        webhook_url: request.webhook_url || '',
        server_url: request.server_url || '',
        device_key: request.device_key || '',
        user_key: request.user_key || '',
        api_token: request.api_token || '',
        template: request.template ?? null,
        url: request.url || '',
      };
      const [success, message] = await NotificationManager.testProviderConfig(config);
      return {
        success,
        message,
        message_zh: success ? '测试成功' : `测试失败: ${message}`,
        message_en: success ? 'Test successful' : `Test failed: ${message}`,
      };
    } catch (e) {
      logger.error(`Failed to test provider config: ${e}`);
      return {
        success: false,
        message: String(e),
        message_zh: `测试失败: ${e}`,
        message_en: `Test failed: ${e}`,
      };
    }
  }

  // ------------------------------------------------------------------
  // 站内通知中心（收件箱）
  // ------------------------------------------------------------------

  @Get('/messages')
  listMessages(
    @Query('unread_only') unreadOnlyRaw?: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    const unreadOnly = parseBoolQuery(unreadOnlyRaw);
    // FastAPI Query(50, ge=1, le=200) / Query(0, ge=0)：越界即 422
    const limit = parseInt(limitRaw ?? '50', 10);
    if (Number.isNaN(limit) || limit < 1 || limit > 200) {
      throw new HttpException('limit must be between 1 and 200', 422);
    }
    const offset = parseInt(offsetRaw ?? '0', 10);
    if (Number.isNaN(offset) || offset < 0) {
      throw new HttpException('offset must be greater than or equal to 0', 422);
    }
    const messages = db.inbox.list(unreadOnly, limit, offset);
    const total = db.inbox.countAll(unreadOnly);
    const unread = db.inbox.unreadCount();
    return {
      messages: messages.map(toOut),
      total,
      unread_count: unread,
    };
  }

  @Get('/messages/unread-count')
  unreadCount() {
    return { unread_count: db.inbox.unreadCount() };
  }

  @Post('/messages/read-all')
  @HttpCode(200)
  markAllRead() {
    const changed = db.inbox.markAllRead();
    bumpInboxRevision();
    return {
      status: true,
      status_code: 200,
      msg_en: `Marked ${changed} messages as read.`,
      msg_zh: `已将 ${changed} 条消息标记为已读。`,
    };
  }

  @Post('/messages/:message_id/read')
  @HttpCode(200)
  markRead(@Param('message_id', StrictIntPipe) messageId: number) {
    if (!db.inbox.markRead(messageId)) {
      throw new HttpException('Message not found', 404);
    }
    bumpInboxRevision();
    return { status: true, status_code: 200, msg_en: 'Message marked as read.', msg_zh: '消息已标记为已读。' };
  }

  @Delete('/messages/:message_id')
  deleteMessage(@Param('message_id', StrictIntPipe) messageId: number) {
    if (!db.inbox.delete(messageId)) {
      throw new HttpException('Message not found', 404);
    }
    bumpInboxRevision();
    return { status: true, status_code: 200, msg_en: 'Message deleted.', msg_zh: '消息已删除。' };
  }

  @Delete('/messages')
  clearMessages() {
    const removed = db.inbox.clear();
    bumpInboxRevision();
    return {
      status: true,
      status_code: 200,
      msg_en: `Cleared ${removed} messages.`,
      msg_zh: `已清空 ${removed} 条消息。`,
    };
  }
}

/**
 * 确认步 — 对应 Vue 版 wizard-step-review.vue。
 * 汇总各步配置，完成按钮调 apiSetup.complete，成功后跳转 #/login。
 */
import { useState } from 'react';
import { Button, Descriptions, message } from 'antd';

import { apiSetup } from '@/api/setup';

import type { AccountData, DownloaderData, NotificationData, RssData } from './types';
import { WizardActions, WizardHeader } from './wizard-shared';

interface Props {
  account: AccountData;
  downloader: DownloaderData;
  rss: RssData;
  notification: NotificationData;
  onPrev: () => void;
}

function maskPassword(pwd: string): string {
  if (pwd.length <= 2) return '**';
  return pwd[0] + '*'.repeat(pwd.length - 2) + pwd[pwd.length - 1];
}

export function WizardStepReview({ account, downloader, rss, notification, onPrev }: Props) {
  const [isLoading, setIsLoading] = useState(false);

  async function completeSetup() {
    setIsLoading(true);
    try {
      await apiSetup.complete({
        username: account.username,
        password: account.password,
        downloader_type: downloader.type,
        downloader_host: downloader.host,
        downloader_username: downloader.username,
        downloader_password: downloader.password,
        downloader_path: downloader.path,
        downloader_ssl: downloader.ssl,
        rss_url: rss.skipped ? '' : rss.url,
        rss_name: rss.skipped ? '' : rss.name,
        notification_enable: !notification.skipped && notification.enable,
        notification_type: notification.type,
        notification_token: notification.token,
        notification_chat_id: notification.chat_id,
      });
      void message.success('设置完成！请使用新凭证登录。');
      // complete 成功后哨兵已写盘，reload 让 setup/status 重新判定（need_setup=false）
      window.location.reload();
    } catch (e) {
      // axios 拦截器以 { status, msg_en, msg_zh } reject —— 优先展示后端中文原因，便于用户修正后重试
      const err = e as { msg_en?: string; msg_zh?: string };
      const detail = err.msg_zh || err.msg_en || '';
      void message.error(detail ? `设置失败，请重试。: ${detail}` : '设置失败，请重试。');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div>
      <WizardHeader title="确认设置" subtitle="在完成设置前确认你的配置。" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Descriptions
          title="创建账户"
          size="small"
          column={1}
          bordered
          items={[
            { key: 'username', label: '用户名', children: account.username },
            { key: 'password', label: '密码', children: maskPassword(account.password) },
          ]}
        />
        <Descriptions
          title="下载客户端"
          size="small"
          column={1}
          bordered
          items={[
            { key: 'host', label: '下载器地址', children: downloader.host },
            { key: 'username', label: '用户名', children: downloader.username },
          ]}
        />
        {!rss.skipped && rss.url && (
          <Descriptions
            title="RSS 订阅源"
            size="small"
            column={1}
            bordered
            items={[{ key: 'name', label: '源名称', children: rss.name || rss.url }]}
          />
        )}
        {!notification.skipped && notification.token && (
          <Descriptions
            title="通知设置"
            size="small"
            column={1}
            bordered
            items={[{ key: 'type', label: '类型', children: notification.type }]}
          />
        )}
      </div>

      <WizardActions
        left={
          <Button onClick={onPrev} disabled={isLoading}>
            上一步
          </Button>
        }
        right={
          <Button type="primary" loading={isLoading} onClick={() => void completeSetup()}>
            {isLoading ? '设置中...' : '完成设置'}
          </Button>
        }
      />
    </div>
  );
}

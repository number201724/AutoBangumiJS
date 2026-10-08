/**
 * 首启向导 — Vue 版 pages/setup.vue 的 React + AntD 移植。
 * 流程：欢迎 → 账号 → 下载器 → RSS → 通知 → 确认。
 * 布局与登录页统一：渐变背景 + 居中卡片。
 */
import { useState } from 'react';
import { Card, Steps, Typography } from 'antd';

import {
  WizardStepAccount,
  WizardStepDownloader,
  WizardStepNotification,
  WizardStepReview,
  WizardStepRss,
  WizardStepWelcome,
  type AccountData,
  type DownloaderData,
  type NotificationData,
  type RssData,
} from '@/components/setup';

const STEP_TITLES = ['欢迎', '账户', '下载器', 'RSS', '通知', '确认'];

export function SetupPage() {
  const [current, setCurrent] = useState(0);

  // 表单数据（对应 Vue 版 setup store 的各段 reactive 状态）
  const [accountData, setAccountData] = useState<AccountData>({
    username: '',
    password: '',
    confirmPassword: '',
  });
  const [downloaderData, setDownloaderData] = useState<DownloaderData>({
    type: 'qbittorrent',
    host: '',
    username: '',
    password: '',
    path: '/downloads/Bangumi',
    ssl: false,
  });
  const [rssData, setRssData] = useState<RssData>({ url: '', name: '', skipped: false });
  const [notificationData, setNotificationData] = useState<NotificationData>({
    enable: false,
    type: 'telegram',
    token: '',
    chat_id: '',
    skipped: false,
  });

  // 测试通过状态（对应 Vue 版 store 的 validation）
  const [validation, setValidation] = useState({
    downloaderTested: false,
    rssTested: false,
    notificationTested: false,
  });

  const totalSteps = STEP_TITLES.length;
  const goNext = () => setCurrent((c) => Math.min(c + 1, totalSteps - 1));
  const goPrev = () => setCurrent((c) => Math.max(c - 1, 0));

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        padding: '24px 0',
      }}
    >
      <Card
        style={{ width: 640, maxWidth: '94vw', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }}
      >
        <Steps
          current={current}
          size="small"
          items={STEP_TITLES.map((title) => ({ title }))}
        />
        <div style={{ textAlign: 'right', margin: '8px 0 16px' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            第 {current + 1} 步，共 {totalSteps} 步
          </Typography.Text>
        </div>

        {current === 0 && <WizardStepWelcome onNext={goNext} />}
        {current === 1 && (
          <WizardStepAccount
            data={accountData}
            onChange={setAccountData}
            onNext={goNext}
            onPrev={goPrev}
          />
        )}
        {current === 2 && (
          <WizardStepDownloader
            data={downloaderData}
            tested={validation.downloaderTested}
            onChange={setDownloaderData}
            onTestedChange={(v) => setValidation((s) => ({ ...s, downloaderTested: v }))}
            onNext={goNext}
            onPrev={goPrev}
          />
        )}
        {current === 3 && (
          <WizardStepRss
            data={rssData}
            tested={validation.rssTested}
            onChange={setRssData}
            onTestedChange={(v) => setValidation((s) => ({ ...s, rssTested: v }))}
            onNext={goNext}
            onPrev={goPrev}
          />
        )}
        {current === 4 && (
          <WizardStepNotification
            data={notificationData}
            tested={validation.notificationTested}
            onChange={setNotificationData}
            onTestedChange={(v) => setValidation((s) => ({ ...s, notificationTested: v }))}
            onNext={goNext}
            onPrev={goPrev}
          />
        )}
        {current === 5 && (
          <WizardStepReview
            account={accountData}
            downloader={downloaderData}
            rss={rssData}
            notification={notificationData}
            onPrev={goPrev}
          />
        )}
      </Card>
    </div>
  );
}

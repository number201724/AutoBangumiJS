/**
 * 下载器步 — 对应 Vue 版 wizard-step-downloader.vue。
 * 连接测试按钮调 apiSetup.testDownloader；连接参数变化后测试结果即失效；
 * 测试失败不阻塞流程，填了地址即可继续。
 */
import { useState } from 'react';
import { Alert, Button, Form, Input, Select, Switch, Typography } from 'antd';

import { apiSetup } from '@/api/setup';

import type { DownloaderData, TestOutcome } from './types';
import { WizardActions, WizardHeader } from './wizard-shared';

const DOWNLOADER_TYPE_OPTIONS = [
  { label: 'qBittorrent', value: 'qbittorrent' },
  { label: 'aria2', value: 'aria2' },
  { label: 'Mock', value: 'mock' },
];

interface Props {
  data: DownloaderData;
  tested: boolean;
  onChange: (data: DownloaderData) => void;
  onTestedChange: (tested: boolean) => void;
  onNext: () => void;
  onPrev: () => void;
}

export function WizardStepDownloader({
  data,
  tested,
  onChange,
  onTestedChange,
  onNext,
  onPrev,
}: Props) {
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestOutcome | null>(null);

  // 通过的测试只对它当时针对的参数有效 —— 修改任一连接字段后恢复为未测试状态
  function update(patch: Partial<DownloaderData>, invalidateTest = false) {
    onChange({ ...data, ...patch });
    if (invalidateTest) {
      onTestedChange(false);
      setTestResult(null);
    }
  }

  async function testConnection() {
    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await apiSetup.testDownloader({ ...data });
      onTestedChange(result.success);
      setTestResult({
        success: result.success,
        message: result.message_zh || result.message_en,
      });
    } catch {
      onTestedChange(false);
      setTestResult({ success: false, message: '连接失败' });
    } finally {
      setIsTesting(false);
    }
  }

  // 密码非必填：qB 可能开了 bypass_local_auth；aria2 走 RPC secret（密码栏），无用户名；mock 无需鉴权
  const canTest =
    Boolean(data.host) &&
    (data.type === 'aria2' || data.type === 'mock' || Boolean(data.username));
  // 鼓励测试但不设死路：后端暂时连不上下载器时用户也能继续
  const canProceed = Boolean(data.host);

  return (
    <div>
      <WizardHeader title="下载客户端" subtitle="连接到你的 qBittorrent 实例。" />
      <Form layout="vertical">
        <Form.Item
          label="下载器类型"
          extra={
            data.type === 'aria2'
              ? 'aria2 请在密码栏填入 RPC secret（用户名会被忽略）。地址示例：172.17.0.1:6800'
              : undefined
          }
        >
          <Select
            value={data.type}
            options={DOWNLOADER_TYPE_OPTIONS}
            onChange={(value) => update({ type: value }, true)}
            style={{ width: 220 }}
          />
        </Form.Item>
        <Form.Item label="下载器地址">
          <Input
            value={data.host}
            placeholder="172.17.0.1:8080"
            aria-label="下载器地址"
            onChange={(e) => update({ host: e.target.value }, true)}
          />
        </Form.Item>
        <Form.Item label="用户名">
          <Input
            value={data.username}
            placeholder="admin"
            autoComplete="username"
            aria-label="用户名"
            onChange={(e) => update({ username: e.target.value }, true)}
          />
        </Form.Item>
        <Form.Item label="密码">
          <Input.Password
            value={data.password}
            autoComplete="current-password"
            aria-label="密码"
            onChange={(e) => update({ password: e.target.value }, true)}
          />
        </Form.Item>
        <Form.Item label="下载地址">
          <Input
            value={data.path}
            placeholder="/downloads/Bangumi"
            aria-label="下载地址"
            onChange={(e) => update({ path: e.target.value })}
          />
        </Form.Item>
        <Form.Item label="SSL">
          <div>
            <Switch checked={data.ssl} onChange={(checked) => update({ ssl: checked }, true)} />
          </div>
        </Form.Item>
      </Form>

      <div>
        <Button disabled={!canTest} loading={isTesting} onClick={() => void testConnection()}>
          {isTesting ? '测试中...' : '测试连接'}
        </Button>
      </div>
      {testResult && (
        <Alert
          style={{ marginTop: 12 }}
          type={testResult.success ? 'success' : 'error'}
          message={testResult.message}
          showIcon
        />
      )}
      {!tested && (
        <Typography.Paragraph
          type="secondary"
          style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}
        >
          可以先跳过连接测试继续设置，之后在设置页中调整连接信息。
        </Typography.Paragraph>
      )}

      <WizardActions
        left={<Button onClick={onPrev}>上一步</Button>}
        right={
          <Button type="primary" disabled={!canProceed} onClick={onNext}>
            下一步
          </Button>
        }
      />
    </div>
  );
}

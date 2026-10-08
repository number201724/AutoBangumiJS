/**
 * 通知步 — 对应 Vue 版 wizard-step-notification.vue。
 * 发送测试按钮调 apiSetup.testNotification；本步可跳过，不跳过则需先通过测试。
 */
import { useState } from 'react';
import { Alert, Button, Form, Input, Select } from 'antd';

import { apiSetup } from '@/api/setup';

import type { NotificationData, TestOutcome } from './types';
import { WizardActions, WizardHeader } from './wizard-shared';

const NOTIFICATION_TYPE_OPTIONS = [
  { label: 'Telegram', value: 'telegram' },
  { label: 'Server Chan', value: 'server-chan' },
  { label: 'Bark', value: 'bark' },
  { label: 'WeChat Work', value: 'wecom' },
];

interface Props {
  data: NotificationData;
  tested: boolean;
  onChange: (data: NotificationData) => void;
  onTestedChange: (tested: boolean) => void;
  onNext: () => void;
  onPrev: () => void;
}

export function WizardStepNotification({
  data,
  tested,
  onChange,
  onTestedChange,
  onNext,
  onPrev,
}: Props) {
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestOutcome | null>(null);

  async function testNotification() {
    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await apiSetup.testNotification(data.type, data.token, data.chat_id);
      onTestedChange(result.success);
      setTestResult({
        success: result.success,
        message: result.message_zh || result.message_en,
      });
    } catch {
      onTestedChange(false);
      setTestResult({ success: false, message: '通知测试失败' });
    } finally {
      setIsTesting(false);
    }
  }

  function skip() {
    onChange({ ...data, skipped: true });
    onNext();
  }

  function next() {
    onChange({ ...data, skipped: false, enable: true });
    onNext();
  }

  const canTest = Boolean(data.token);

  return (
    <div>
      <WizardHeader title="通知设置" subtitle="获取新集数的通知推送（可选）。" />
      <Form layout="vertical">
        <Form.Item label="类型">
          <Select
            value={data.type}
            options={NOTIFICATION_TYPE_OPTIONS}
            onChange={(value) => onChange({ ...data, type: value })}
            style={{ width: 220 }}
          />
        </Form.Item>
        <Form.Item label="Token">
          <Input
            value={data.token}
            autoComplete="off"
            aria-label="Token"
            onChange={(e) => onChange({ ...data, token: e.target.value })}
          />
        </Form.Item>
        <Form.Item label="Chat ID">
          <Input
            value={data.chat_id}
            aria-label="Chat ID"
            onChange={(e) => onChange({ ...data, chat_id: e.target.value })}
          />
        </Form.Item>
      </Form>

      <div>
        <Button disabled={!canTest} loading={isTesting} onClick={() => void testNotification()}>
          {isTesting ? '测试中...' : '发送测试'}
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

      <WizardActions
        left={<Button onClick={onPrev}>上一步</Button>}
        right={
          <>
            <Button onClick={skip}>跳过</Button>
            <Button type="primary" disabled={!tested} onClick={next}>
              下一步
            </Button>
          </>
        }
      />
    </div>
  );
}

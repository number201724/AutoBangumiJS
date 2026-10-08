/**
 * RSS 步 — 对应 Vue 版 wizard-step-rss.vue。
 * 测试按钮调 apiSetup.testRss，成功后展示源标题/条目数量并自动回填源名称；
 * 本步可跳过，不跳过则需先通过测试。
 */
import { useState } from 'react';
import { Alert, Button, Form, Input } from 'antd';

import { apiSetup } from '@/api/setup';

import type { RssData, TestOutcome } from './types';
import { WizardActions, WizardHeader } from './wizard-shared';

interface Props {
  data: RssData;
  tested: boolean;
  onChange: (data: RssData) => void;
  onTestedChange: (tested: boolean) => void;
  onNext: () => void;
  onPrev: () => void;
}

export function WizardStepRss({
  data,
  tested,
  onChange,
  onTestedChange,
  onNext,
  onPrev,
}: Props) {
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestOutcome | null>(null);
  const [feedTitle, setFeedTitle] = useState('');
  const [itemCount, setItemCount] = useState(0);

  async function testFeed() {
    if (!data.url) return;
    setIsTesting(true);
    setTestResult(null);
    setFeedTitle('');
    try {
      const result = await apiSetup.testRss(data.url);
      setTestResult({
        success: result.success,
        message: result.message_zh || result.message_en,
      });
      if (result.success) {
        const title = result.title ?? '';
        setFeedTitle(title);
        setItemCount(result.item_count ?? 0);
        // 自动回填源名称，但不覆盖用户已填写的内容
        if (!data.name && title) {
          onChange({ ...data, name: title });
        }
        onTestedChange(true);
      }
    } catch {
      setTestResult({ success: false, message: '获取订阅源失败' });
    } finally {
      setIsTesting(false);
    }
  }

  function skip() {
    onChange({ ...data, skipped: true });
    onNext();
  }

  function next() {
    onChange({ ...data, skipped: false });
    onNext();
  }

  return (
    <div>
      <WizardHeader title="RSS 订阅源" subtitle="添加你的第一个番剧 RSS 源。" />
      <Form layout="vertical">
        <Form.Item label="RSS 源地址">
          <Input
            value={data.url}
            placeholder="https://mikanani.me/RSS/..."
            aria-label="RSS 源地址"
            onChange={(e) => onChange({ ...data, url: e.target.value })}
          />
        </Form.Item>
        {data.name && (
          <Form.Item label="源名称">
            <Input
              value={data.name}
              aria-label="源名称"
              onChange={(e) => onChange({ ...data, name: e.target.value })}
            />
          </Form.Item>
        )}
      </Form>

      <div>
        <Button disabled={!data.url} loading={isTesting} onClick={() => void testFeed()}>
          {isTesting ? '测试中...' : '测试订阅源'}
        </Button>
      </div>
      {testResult && (
        <Alert
          style={{ marginTop: 12 }}
          type={testResult.success ? 'success' : 'error'}
          message={testResult.message}
          description={
            feedTitle ? (
              <div>
                <div>
                  <strong>源标题：</strong>
                  {feedTitle}
                </div>
                <div>
                  <strong>条目数量：</strong>
                  {itemCount}
                </div>
              </div>
            ) : undefined
          }
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

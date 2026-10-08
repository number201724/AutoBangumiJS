/**
 * 日志 — React/AntD port of pages/index/log.vue。
 * 等宽 pre 展示，自动滚动到底，手动刷新 / 复制 / 清空，10s 静默轮询。
 */
import { useEffect, useRef } from 'react';
import { Button, Card, Modal, Space, message, theme } from 'antd';

import { useLogStore } from '@/stores/log';

export function LogPage() {
  const { token } = theme.useToken();
  const { log, refreshing, getLog, clearLog } = useLogStore();
  const preRef = useRef<HTMLPreElement | null>(null);
  // 用户回翻历史时暂停吸附；回到底部附近后恢复自动滚动
  const stickToBottom = useRef(true);

  // 首次拉取 + 10s 静默轮询（页面不可见时跳过）
  useEffect(() => {
    void getLog();
    const timer = setInterval(() => {
      if (!document.hidden) void getLog();
    }, 10_000);
    return () => clearInterval(timer);
  }, [getLog]);

  useEffect(() => {
    const el = preRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [log]);

  function onScroll() {
    const el = preRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(log);
      void message.success('复制成功!');
    } catch {
      void message.error('您的浏览器不支持剪贴板操作!');
    }
  }

  function onClear() {
    Modal.confirm({
      title: '清空日志',
      content: '确定清空日志？此操作无法撤销。',
      okText: '清空日志',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => clearLog(),
    });
  }

  return (
    <Card
      title="日志"
      extra={
        <Space>
          <Button size="small" loading={refreshing} onClick={() => void getLog(true)}>
            刷新
          </Button>
          <Button size="small" onClick={() => void onCopy()}>
            复制
          </Button>
          <Button size="small" danger onClick={onClear}>
            清空日志
          </Button>
        </Space>
      }
    >
      <pre
        ref={preRef}
        onScroll={onScroll}
        style={{
          margin: 0,
          padding: 12,
          maxHeight: '68vh',
          overflow: 'auto',
          borderRadius: token.borderRadius,
          background: token.colorFillQuaternary,
          color: token.colorText,
          fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
          fontSize: 12.5,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {log || '暂无日志。后台任务运行后这里会显示日志内容。'}
      </pre>
    </Card>
  );
}

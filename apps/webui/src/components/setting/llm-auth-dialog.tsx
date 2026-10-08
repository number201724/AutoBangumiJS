/**
 * LLM 提供商授权对话框（对应 Vue 版 llm-auth-dialog）。
 * device_code：展示验证链接 + 用户码，轮询 auth status 直到连接。
 * redirect_paste：展示授权链接，用户粘贴回调 code 后调 auth complete。
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Input, Modal, Typography, message, theme } from 'antd';

import { apiLlm, type AuthBeginResult } from '@/api/llm';

interface LlmAuthDialogProps {
  open: boolean;
  providerId: string;
  displayName: string;
  onClose: () => void;
  onConnected: () => void;
}

export function LlmAuthDialog({
  open,
  providerId,
  displayName,
  onClose,
  onConnected,
}: LlmAuthDialogProps) {
  const [challenge, setChallenge] = useState<AuthBeginResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [pastedCode, setPastedCode] = useState('');
  const pollTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const { token } = theme.useToken();

  function stopPolling() {
    if (pollTimer.current !== undefined) {
      clearInterval(pollTimer.current);
      pollTimer.current = undefined;
    }
  }

  function close() {
    stopPolling();
    setChallenge(null);
    setPastedCode('');
    onClose();
  }

  async function begin() {
    setLoading(true);
    try {
      const result = await apiLlm.authBegin(providerId);
      setChallenge(result);
      if (result.method === 'device_code') startPolling();
    } catch {
      void message.error('授权失败');
      close();
    } finally {
      setLoading(false);
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer.current = setInterval(() => {
      void (async () => {
        try {
          const status = await apiLlm.authStatus(providerId);
          if (status.connected) {
            stopPolling();
            void message.success(`已连接：${status.account_label}`);
            onConnected();
            close();
          }
        } catch {
          // 轮询失败静默重试
        }
      })();
    }, 3000);
  }

  // redirect_paste：用户在自己设备打开授权链接，把回调 code/URL 粘回来
  async function submitCode() {
    if (!challenge) return;
    setLoading(true);
    try {
      const res = (await apiLlm.authComplete(providerId, challenge.state, pastedCode.trim())) as {
        account_label?: string;
      };
      void message.success(`已连接：${res.account_label ?? ''}`);
      onConnected();
      close();
    } catch {
      void message.error('授权失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) void begin();
    else stopPolling();
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, providerId]);

  return (
    <Modal
      open={open}
      title={`连接 · ${displayName}`}
      footer={null}
      onCancel={close}
      width={460}
      destroyOnHidden={false}
    >
      {challenge ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {challenge.method === 'device_code' ? (
            <>
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                打开链接并输入下方代码完成授权：
              </Typography.Text>
              {challenge.verification_uri ? (
                <Typography.Link
                  href={challenge.verification_uri}
                  target="_blank"
                  rel="noopener"
                  style={{ fontSize: 13, wordBreak: 'break-all' }}
                >
                  {challenge.verification_uri}
                </Typography.Link>
              ) : null}
              <div
                style={{
                  fontFamily: 'monospace',
                  fontSize: 22,
                  fontWeight: 700,
                  letterSpacing: '0.15em',
                  textAlign: 'center',
                  padding: 12,
                  borderRadius: 8,
                  background: token.colorPrimaryBg,
                  color: token.colorPrimary,
                }}
              >
                {challenge.user_code}
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                等待授权中…
              </Typography.Text>
            </>
          ) : (
            <>
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                在任意设备打开此链接授权，然后把回调 code 粘贴到下方：
              </Typography.Text>
              {challenge.authorize_url ? (
                <Typography.Link
                  href={challenge.authorize_url}
                  target="_blank"
                  rel="noopener"
                  style={{ fontSize: 13, wordBreak: 'break-all' }}
                >
                  {challenge.authorize_url}
                </Typography.Link>
              ) : null}
              <Input.TextArea
                rows={2}
                placeholder="粘贴授权 code 或回调 URL"
                value={pastedCode}
                onChange={(e) => setPastedCode(e.target.value)}
              />
              <Button
                type="primary"
                loading={loading}
                disabled={!pastedCode.trim()}
                onClick={() => void submitCode()}
              >
                连接
              </Button>
            </>
          )}
        </div>
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          等待授权中…
        </Typography.Text>
      )}
    </Modal>
  );
}

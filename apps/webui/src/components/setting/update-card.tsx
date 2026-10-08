/**
 * 软件更新（对应 Vue 版 update-card）。
 * - channel/auto_check：无未保存修改时即时写回配置，否则只改内存随全局保存提交
 * - 检查更新：apiUpdate.check；apply/rollback 后端暂返回 400 + 不可用提示，
 *   这里用 silent + validateStatus 直接读响应体里的 message（拦截器认的是
 *   msg_zh 信封字段，直接走封装会丢掉后端的说明文案）
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Modal, Segmented, Space, Spin, Switch, Tag, Typography, message, theme } from 'antd';

import { api } from '@/api/client';
import { apiProgram } from '@/api/program';
import { apiUpdate, type UpdateCheckResult } from '@/api/update';
import { useConfigStore, useConfigGroup } from '@/stores/config';

import { SectionCard } from './section-card';
import { SettingRow } from './setting-row';

/** 后端未来会带的字段（Vue 版 UpdateInfo 有，当前 Node 构建恒为 overlay:null） */
interface UpdateInfoExtra {
  can_rollback?: boolean;
  applied_version?: string;
}

interface UpdateActionResult {
  success: boolean;
  message?: string;
  message_zh?: string;
  restart_required?: boolean;
}

async function postUpdateAction(path: string, channel?: string): Promise<UpdateActionResult> {
  const { data } = await api.post<UpdateActionResult>(path, undefined, {
    params: channel ? { channel } : undefined,
    silent: true,
    validateStatus: () => true,
  });
  return data;
}

/**
 * 极简且防 XSS 的 Release 说明渲染：先转义所有 HTML，再对少量 markdown
 * 语法做替换（标题/加粗/行内代码/链接/无序列表/换行）。
 */
function renderNotes(md: string): string {
  if (!md) return '';
  const escaped = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped
    .replace(/^###?\s?#*\s*(.*)$/gm, '<strong>$1</strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+?)`/g, '<code>$1</code>')
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    )
    .replace(/^[-*]\s+(.*)$/gm, '• $1')
    .replace(/\n/g, '<br>');
}

export function UpdateCard() {
  const [updateCfg] = useConfigGroup('update');
  const persistUpdateConfig = useConfigStore((s) => s.persistUpdateConfig);
  const { token } = theme.useToken();

  const [info, setInfo] = useState<(UpdateCheckResult & UpdateInfoExtra) | null>(null);
  const [version, setVersion] = useState('');
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartTimedOut, setRestartTimedOut] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);

  const pollTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const timeoutTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const checkedOnce = useRef(false);

  const channel = updateCfg.channel;
  const autoCheck = updateCfg.auto_check;
  const currentVersion = info?.current || version || '-';
  const hasUpdate = info?.has_update === true;
  const canRollback = info?.can_rollback === true;
  const appliedVersion = info?.applied_version || '';
  const notesHtml = renderNotes(info?.notes ?? '');

  // 挂载：取当前版本 + 自动检查（走缓存、保持安静）
  useEffect(() => {
    void (async () => {
      try {
        const status = await apiProgram.status();
        setVersion(status.version);
      } catch {
        /* ignore */
      }
    })();
    if (autoCheck && !checkedOnce.current) {
      checkedOnce.current = true;
      void onCheck(channel, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (pollTimer.current !== undefined) clearInterval(pollTimer.current);
      if (timeoutTimer.current !== undefined) clearTimeout(timeoutTimer.current);
    };
  }, []);

  // userInitiated：来自"检查更新"按钮，强制绕过后端缓存并给出反馈
  async function onCheck(ch: string, userInitiated: boolean) {
    setChecking(true);
    try {
      const res = await apiUpdate.check(ch, userInitiated);
      setInfo(res);
      setLastCheckedAt(new Date());
      if (res.error) {
        // 展示后端的具体原因（如 GitHub 限流 / 无匹配 Release）
        void message.error(`检查更新失败: ${res.error}`);
      } else if (userInitiated) {
        if (res.has_update) {
          void message.info(`发现新版本 ${res.latest ?? ''}`);
        } else {
          void message.success('已是最新版本。');
        }
      }
    } catch {
      // 拦截器已提示网络错误
    } finally {
      setChecking(false);
    }
  }

  function onChannelChange(value: string | number) {
    const ch = value === 'beta' ? 'beta' : 'stable';
    void persistUpdateConfig({ channel: ch }).then(() => {
      // 切换渠道后若已检查过，则自动用新渠道重新检查
      if (info) void onCheck(ch, false);
    });
  }

  function onAutoCheckChange(value: boolean) {
    void persistUpdateConfig({ auto_check: value });
  }

  function startRestartWatch() {
    setRestarting(true);
    setRestartTimedOut(false);
    let sawDown = false;
    if (pollTimer.current !== undefined) clearInterval(pollTimer.current);
    pollTimer.current = setInterval(() => {
      void (async () => {
        try {
          await apiProgram.status();
          // 重启完成：先经历一次不可达（sawDown）再恢复，才判定已回来
          if (sawDown) {
            if (pollTimer.current !== undefined) clearInterval(pollTimer.current);
            if (timeoutTimer.current !== undefined) clearTimeout(timeoutTimer.current);
            window.location.reload();
          }
        } catch {
          sawDown = true;
        }
      })();
    }, 3000);
    // 超时仍未恢复：提示需要 restart: unless-stopped 或手动重启
    if (timeoutTimer.current !== undefined) clearTimeout(timeoutTimer.current);
    timeoutTimer.current = setTimeout(() => setRestartTimedOut(true), 60000);
  }

  async function runAction(kind: 'apply' | 'rollback') {
    setApplying(true);
    try {
      const res =
        kind === 'apply'
          ? await postUpdateAction('api/v1/update/apply', channel)
          : await postUpdateAction('api/v1/update/rollback');
      if (res.success && res.restart_required) {
        startRestartWatch();
      } else {
        void message.error(res.message_zh || res.message || '更新失败');
        setApplying(false);
      }
    } catch {
      setApplying(false);
    }
  }

  function onApplyClick() {
    Modal.confirm({
      title: '更新 AutoBangumi？',
      content: '将下载并应用更新，随后应用会重启以生效。',
      okText: '立即更新',
      cancelText: '取消',
      onOk: () => runAction('apply'),
    });
  }

  function onRollbackClick() {
    Modal.confirm({
      title: '回滚',
      content: '回滚到上一个版本？应用将重启。',
      okText: '回滚',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => runAction('rollback'),
    });
  }

  return (
    <SectionCard title="软件更新">
      <SettingRow label="当前版本">
        <span style={{ fontSize: 14 }}>{currentVersion}</span>
      </SettingRow>

      {info?.latest ? (
        <SettingRow label="最新版本">
          <Space>
            <span style={{ fontSize: 14 }}>{info.latest}</span>
            {hasUpdate ? <Tag color="success">有可用更新</Tag> : null}
          </Space>
        </SettingRow>
      ) : null}

      {appliedVersion ? (
        <Typography.Text style={{ fontSize: 12, color: token.colorPrimary }}>
          正在镜像之上运行更新覆盖层（v{appliedVersion}）。
        </Typography.Text>
      ) : null}

      <SettingRow label="更新渠道">
        <Segmented
          value={channel}
          disabled={applying || restarting}
          onChange={onChannelChange}
          options={[
            { label: '稳定版', value: 'stable' },
            { label: '测试版', value: 'beta' },
          ]}
        />
      </SettingRow>

      <SettingRow label="自动检查">
        <Switch
          checked={autoCheck}
          disabled={applying || restarting}
          onChange={onAutoCheckChange}
        />
      </SettingRow>

      {info && !info.error && !hasUpdate ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          已是最新版本。
        </Typography.Text>
      ) : null}

      {hasUpdate && notesHtml ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            更新说明
          </Typography.Text>
          <div
            style={{
              maxHeight: 200,
              overflow: 'auto',
              padding: '8px 10px',
              borderRadius: 6,
              border: `1px solid ${token.colorBorderSecondary}`,
              fontSize: 12,
              lineHeight: 1.6,
              color: token.colorTextSecondary,
              wordBreak: 'break-word',
            }}
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: notesHtml }}
          />
        </div>
      ) : null}

      {restarting ? (
        <Space>
          <Spin size="small" />
          <span style={{ fontSize: 13, color: token.colorPrimary }}>
            正在应用更新并重启……本页将自动刷新。
          </span>
        </Space>
      ) : null}

      {restartTimedOut ? (
        <Typography.Text type="warning" style={{ fontSize: 12 }}>
          应用较长时间未恢复。请确认容器以 `restart: unless-stopped` 运行，或手动重启。
        </Typography.Text>
      ) : null}

      {lastCheckedAt ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          上次检查 {lastCheckedAt.toLocaleTimeString()}
        </Typography.Text>
      ) : null}

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        应用内更新要求容器以 `restart: unless-stopped` 运行，以便自行重启来应用更新。
      </Typography.Text>

      <Space wrap>
        <Button
          size="small"
          loading={checking}
          disabled={applying || restarting}
          onClick={() => void onCheck(channel, true)}
        >
          {checking ? '检查中…' : '检查更新'}
        </Button>
        <Button
          type="primary"
          size="small"
          disabled={!hasUpdate || applying || restarting}
          loading={applying && !restarting}
          onClick={onApplyClick}
        >
          立即更新
        </Button>
        {canRollback ? (
          <Button danger size="small" disabled={applying || restarting} onClick={onRollbackClick}>
            回滚
          </Button>
        ) : null}
      </Space>
    </SectionCard>
  );
}

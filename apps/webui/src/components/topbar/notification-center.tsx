/**
 * Notification center — AntD Popover port of components/layout/ab-notification-center.vue.
 */
import { useEffect, useState } from 'react';
import { Badge, Button, Empty, Popover, Spin } from 'antd';
import {
  BellOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';

import {
  bodyOf,
  titleOf,
  useNotificationStore,
} from '@/stores/notification';
import type { InboxMessage } from '@ab/types';

// 点条目跳转的目标页面；未列出的 kind 不跳转
const KIND_ROUTES: Record<string, string> = {
  update_available: '/config',
  update_applied: '/config',
  update_failed: '/config',
  downloader_unavailable: '/config',
  rss_failure: '/rss',
  offset_review: '/bangumi',
  download_failure: '/bangumi',
  rename_conflict: '/downloader',
};

const SEVERITY_ICON = {
  error: <CloseCircleOutlined style={{ color: '#ff4d4f' }} />,
  warning: <ExclamationCircleOutlined style={{ color: '#faad14' }} />,
  info: <InfoCircleOutlined style={{ color: '#1890ff' }} />,
} as const;

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(iso).toLocaleDateString();
}

function MessageItem({ msg, onNavigate }: { msg: InboxMessage; onNavigate: (msg: InboxMessage) => void }) {
  const remove = useNotificationStore((s) => s.remove);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onNavigate(msg)}
      onKeyDown={(e) => e.key === 'Enter' && onNavigate(msg)}
      style={{
        display: 'flex',
        gap: 8,
        padding: '8px 12px',
        cursor: 'pointer',
        borderRadius: 6,
        background: msg.read ? 'transparent' : 'rgba(24, 144, 255, 0.06)',
      }}
    >
      <div style={{ paddingTop: 2 }}>{SEVERITY_ICON[msg.severity as keyof typeof SEVERITY_ICON] ?? SEVERITY_ICON.info}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, fontSize: 13 }}>
          {titleOf(msg)}
          {msg.count > 1 && <span style={{ color: '#999', marginLeft: 4 }}>×{msg.count}</span>}
        </div>
        <div style={{ fontSize: 12, color: '#666', wordBreak: 'break-all' }}>{bodyOf(msg)}</div>
        <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>{relativeTime(msg.updated_at)}</div>
      </div>
      <Button
        type="text"
        size="small"
        icon={<DeleteOutlined />}
        aria-label="删除"
        onClick={(e) => {
          e.stopPropagation();
          void remove(msg.id);
        }}
      />
    </div>
  );
}

export function NotificationCenter() {
  const navigate = useNavigate();
  const {
    messages,
    unreadCount,
    isLoading,
    panelOpen,
    setPanelOpen,
    fetchMessages,
    fetchUnread,
    markRead,
    markAllRead,
    clearAll,
  } = useNotificationStore();
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    void fetchUnread();
  }, [fetchUnread]);

  useEffect(() => {
    if (panelOpen) {
      void fetchMessages();
    } else {
      setConfirmClear(false);
    }
  }, [panelOpen, fetchMessages]);

  function onItemClick(msg: InboxMessage) {
    void markRead(msg.id);
    const route = KIND_ROUTES[msg.kind];
    if (route) {
      setPanelOpen(false);
      navigate(route);
    }
  }

  function onClearClick() {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    void clearAll();
  }

  const panel = (
    <div style={{ width: 360, maxHeight: 480, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 4px 8px',
          borderBottom: '1px solid #f0f0f0',
        }}
      >
        <span style={{ fontWeight: 600 }}>
          通知中心
          {unreadCount > 0 && <span style={{ color: '#888' }}> · {unreadCount} 条未读</span>}
        </span>
        <span>
          {unreadCount > 0 && (
            <Button type="link" size="small" onClick={() => void markAllRead()}>
              全部已读
            </Button>
          )}
          {messages.length > 0 && (
            <Button type="link" size="small" danger={confirmClear} onClick={onClearClick}>
              {confirmClear ? '确认清空？' : '清空'}
            </Button>
          )}
        </span>
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {isLoading && messages.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <Spin size="small" />
          </div>
        ) : messages.length === 0 ? (
          <Empty description="没有通知" imageStyle={{ height: 60 }} />
        ) : (
          messages.map((msg) => <MessageItem key={msg.id} msg={msg} onNavigate={onItemClick} />)
        )}
      </div>
    </div>
  );

  return (
    <Popover
      content={panel}
      trigger="click"
      placement="bottomRight"
      open={panelOpen}
      onOpenChange={setPanelOpen}
      arrow={false}
    >
      <Badge count={unreadCount} size="small" offset={[-4, 4]}>
        <Button type="text" icon={<BellOutlined style={{ fontSize: 18 }} />} aria-label="通知中心" />
      </Badge>
    </Popover>
  );
}

/**
 * Status menu — React port of the Vue ab-status-bar: running indicator +
 * program controls (start / pause / restart / shutdown) + refresh poster +
 * reset rules + profile.
 */
import { useState } from 'react';
import { Badge, Dropdown, Modal, message, type MenuProps } from 'antd';
import {
  CaretRightOutlined,
  FormatPainterOutlined,
  MenuOutlined,
  PauseOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  UserOutlined,
} from '@ant-design/icons';

import { apiBangumi } from '@/api/bangumi';
import { apiProgram } from '@/api/program';
import { useEventsStore } from '@/stores/events';
import { ChangeAccountModal } from './change-account-modal';

export function StatusMenu() {
  const status = useEventsStore((s) => s.status);
  const [showAccount, setShowAccount] = useState(false);
  const running = status?.status ?? false;

  async function call(fn: () => Promise<unknown>, okText: string) {
    try {
      await fn();
      void message.success(okText);
    } catch {
      /* interceptor toasts */
    }
  }

  const items: MenuProps['items'] = [
    {
      key: 'start',
      icon: <CaretRightOutlined />,
      label: '启动',
      disabled: running,
      onClick: () => void call(apiProgram.start, '程序启动中'),
    },
    {
      key: 'pause',
      icon: <PauseOutlined />,
      label: '暂停',
      disabled: !running,
      onClick: () => void call(apiProgram.stop, '程序已暂停'),
    },
    {
      key: 'restart',
      icon: <ReloadOutlined />,
      label: '重启',
      onClick: () => void call(apiProgram.restart, '程序重启中'),
    },
    {
      key: 'shutdown',
      icon: <PoweroffOutlined />,
      label: '关闭程序',
      danger: true,
      onClick: () => {
        Modal.confirm({
          title: '确认关闭 AutoBangumi？',
          content: '进程将退出，需要手动重新启动。',
          okText: '关闭',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: () => call(apiProgram.shutdown, '程序已关闭'),
        });
      },
    },
    { type: 'divider' },
    {
      key: 'refresh_poster',
      icon: <ReloadOutlined />,
      label: '刷新全部海报',
      onClick: () => void call(apiBangumi.refreshPosterAll, '已开始刷新海报'),
    },
    {
      key: 'reset_rule',
      icon: <FormatPainterOutlined />,
      label: '重置全部规则',
      danger: true,
      onClick: () => {
        Modal.confirm({
          title: '确认重置全部规则？',
          content: '将删除所有番剧规则与种子记录（不影响已下载文件）。',
          okText: '重置',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: () => call(apiBangumi.resetAll, '已重置全部规则'),
        });
      },
    },
    { type: 'divider' },
    {
      key: 'profile',
      icon: <UserOutlined />,
      label: '账号设置',
      onClick: () => setShowAccount(true),
    },
  ];

  return (
    <>
      <Dropdown menu={{ items }} trigger={['click']} placement="bottomRight">
        <Badge status={running ? 'processing' : 'default'} offset={[-4, 20]}>
          <MenuOutlined style={{ fontSize: 18, cursor: 'pointer' }} />
        </Badge>
      </Dropdown>
      <ChangeAccountModal open={showAccount} onClose={() => setShowAccount(false)} />
    </>
  );
}

/**
 * Main layout — sidebar navigation + header (AntD port of the Vue topbar/sidebar).
 * Header: search trigger (global search modal), notification center,
 * status menu (program controls + profile), username + logout.
 */
import { Layout, Button, Menu } from 'antd';
import {
  CalendarOutlined,
  DownloadOutlined,
  FileTextOutlined,
  LogoutOutlined,
  PlayCircleOutlined,
  SearchOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import { useEventStream } from '@/hooks/use-event-stream';
import { useAuthStore } from '@/stores/auth';
import { NotificationCenter } from '@/components/topbar/notification-center';
import { StatusMenu } from '@/components/topbar/status-menu';
import { SearchEntry } from '@/components/topbar/search-entry';

const { Sider, Header, Content } = Layout;

const MENU_ITEMS = [
  { key: '/bangumi', icon: <VideoCameraOutlined />, label: '番剧管理' },
  { key: '/calendar', icon: <CalendarOutlined />, label: '放送日历' },
  { key: '/rss', icon: <ThunderboltOutlined />, label: 'RSS 订阅' },
  { key: '/downloader', icon: <DownloadOutlined />, label: '下载器' },
  { key: '/player', icon: <PlayCircleOutlined />, label: '播放器' },
  { key: '/log', icon: <FileTextOutlined />, label: '日志' },
  { key: '/config', icon: <SettingOutlined />, label: '设置' },
];

export function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { username, logout } = useAuthStore();
  useEventStream();

  const selected = MENU_ITEMS.find((i) => location.pathname.startsWith(i.key))?.key ?? '/bangumi';

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider breakpoint="lg" collapsedWidth="60" theme="light">
        <div
          style={{
            height: 56,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 700,
            fontSize: 16,
          }}
        >
          AB
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selected]}
          items={MENU_ITEMS}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 8,
            paddingInline: 16,
          }}
        >
          <SearchEntry />
          <NotificationCenter />
          <StatusMenu />
          <span style={{ color: '#555', marginInline: 8 }}>{username}</span>
          <Button type="text" icon={<LogoutOutlined />} onClick={() => void logout()}>
            退出
          </Button>
        </Header>
        <Content style={{ padding: 24, overflow: 'auto' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}

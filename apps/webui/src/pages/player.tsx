/**
 * 播放器 — React/AntD port of pages/index/player.vue + components/setting/config-player.vue。
 * Plex / Jellyfin 等媒体服务器地址存 localStorage（与 Vue 版同键），
 * jump 模式生成新标签页跳转链接，iframe 模式内嵌播放。
 */
import { Button, Card, Empty, Input, Segmented, Space, Typography } from 'antd';
import { PlayCircleOutlined } from '@ant-design/icons';

import { normalizeUrl, usePlayerStore, type MediaPlayerType } from '@/stores/player';

const TYPE_OPTIONS: Array<{ value: MediaPlayerType; label: string }> = [
  { value: 'jump', label: '新标签页跳转' },
  { value: 'iframe', label: '内嵌播放' },
];

export function PlayerPage() {
  const { type, rawUrl, setType, setRawUrl } = usePlayerStore();
  const url = normalizeUrl(rawUrl);

  const configCard = (
    <Card size="small" title="播放器设置">
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space wrap size={12}>
          <Segmented<MediaPlayerType>
            value={type}
            options={TYPE_OPTIONS}
            onChange={setType}
          />
          <Input
            style={{ width: 320, maxWidth: '100%' }}
            placeholder="http://192.168.1.100:8096"
            allowClear
            value={rawUrl}
            onChange={(e) => setRawUrl(e.target.value)}
          />
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          输入媒体服务器的 URL（Jellyfin、Emby、Plex 等），仅保存在本浏览器。
        </Typography.Text>
      </Space>
    </Card>
  );

  if (!url) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {configCard}
        <Card>
          <Empty
            description={
              <>
                <Typography.Title level={4}>播放器未配置</Typography.Title>
                <Typography.Text type="secondary">
                  连接媒体服务器以在此直接播放
                </Typography.Text>
                <div style={{ marginTop: 16, textAlign: 'left', maxWidth: 420, margin: '16px auto 0' }}>
                  <p>1. 选择模式 — 新标签页跳转，或直接内嵌播放。</p>
                  <p>2. 设置播放器地址 — 输入媒体服务器的 URL（Jellyfin、Emby、Plex 等）。</p>
                  <p>3. 开始观看 — 播放器将嵌入此处，方便随时访问。</p>
                </div>
              </>
            }
          />
        </Card>
      </div>
    );
  }

  if (type === 'jump') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {configCard}
        <Card>
          <Space direction="vertical" size={12} style={{ width: '100%', textAlign: 'center' }}>
            <Typography.Text>
              播放器地址：<Typography.Text code>{url}</Typography.Text>
            </Typography.Text>
            <div>
              <Button
                type="primary"
                size="large"
                icon={<PlayCircleOutlined />}
                href={url}
                target="_blank"
                rel="noreferrer"
              >
                在新标签页打开播放器
              </Button>
            </div>
          </Space>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {configCard}
      <iframe
        src={url}
        title="播放器"
        allowFullScreen
        style={{
          width: '100%',
          height: 'calc(100vh - 240px)',
          border: '1px solid rgba(128, 128, 128, 0.3)',
          borderRadius: 8,
        }}
      />
    </div>
  );
}

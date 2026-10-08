/** 下载设置（对应 Vue 版 config-download）。 */
import { Alert, Input, Select, Switch } from 'antd';

import { useConfigGroup } from '@/stores/config';

import { SectionCard } from './section-card';
import { SettingRow } from './setting-row';

export function ConfigDownload() {
  const [downloader, setDownloader] = useConfigGroup('downloader');

  return (
    <SectionCard title="下载设置">
      {downloader.type === 'aria2' ? (
        <Alert
          type="info"
          showIcon
          message="aria2 请在密码栏填入 RPC secret（用户名会被忽略）。地址示例：172.17.0.1:6800"
        />
      ) : null}
      <SettingRow label="下载器类型">
        <Select
          style={{ width: 240 }}
          value={downloader.type}
          onChange={(v) => setDownloader({ ...downloader, type: v })}
          options={[
            { label: 'qbittorrent', value: 'qbittorrent' },
            { label: 'aria2', value: 'aria2' },
            { label: 'mock', value: 'mock' },
          ]}
        />
      </SettingRow>
      <SettingRow label="下载器地址">
        <Input
          style={{ width: 280 }}
          placeholder="127.0.0.1:8080"
          value={downloader.host}
          onChange={(e) => setDownloader({ ...downloader, host: e.target.value })}
        />
      </SettingRow>
      <SettingRow label="用户名">
        <Input
          style={{ width: 280 }}
          placeholder="admin"
          value={downloader.username}
          onChange={(e) => setDownloader({ ...downloader, username: e.target.value })}
        />
      </SettingRow>
      <SettingRow label="密码">
        <Input.Password
          style={{ width: 280 }}
          autoComplete="off"
          value={downloader.password}
          onChange={(e) => setDownloader({ ...downloader, password: e.target.value })}
        />
      </SettingRow>
      <SettingRow label="下载地址">
        <Input
          style={{ width: 280 }}
          placeholder="/downloads/Bangumi"
          value={downloader.path}
          onChange={(e) => setDownloader({ ...downloader, path: e.target.value })}
        />
      </SettingRow>
      <SettingRow label="SSL">
        <Switch
          checked={downloader.ssl}
          onChange={(v) => setDownloader({ ...downloader, ssl: v })}
        />
      </SettingRow>
    </SectionCard>
  );
}

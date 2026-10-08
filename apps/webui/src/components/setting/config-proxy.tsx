/** 代理设置（对应 Vue 版 config-proxy）。 */
import { Input, InputNumber, Select, Switch } from 'antd';

import { useConfigGroup } from '@/stores/config';

import { SectionCard } from './section-card';
import { SettingRow } from './setting-row';

export function ConfigProxy() {
  const [proxy, setProxy] = useConfigGroup('proxy');

  return (
    <SectionCard title="代理设置">
      <SettingRow label="启用">
        <Switch
          checked={proxy.enable}
          onChange={(v) => setProxy({ ...proxy, enable: v })}
        />
      </SettingRow>
      <SettingRow label="类型">
        <Select
          style={{ width: 240 }}
          value={proxy.type}
          onChange={(v) => setProxy({ ...proxy, type: v })}
          options={[
            { label: 'http', value: 'http' },
            { label: 'https', value: 'https' },
            { label: 'socks5', value: 'socks5' },
          ]}
        />
      </SettingRow>
      <SettingRow label="地址">
        <Input
          style={{ width: 280 }}
          placeholder="127.0.0.1"
          value={proxy.host}
          onChange={(e) => setProxy({ ...proxy, host: e.target.value })}
        />
      </SettingRow>
      <SettingRow label="端口">
        <InputNumber
          style={{ width: 180 }}
          min={0}
          max={65535}
          placeholder="7890"
          value={proxy.port}
          onChange={(v) => setProxy({ ...proxy, port: v ?? 0 })}
        />
      </SettingRow>
      <SettingRow label="用户名">
        <Input
          style={{ width: 280 }}
          placeholder="username"
          value={proxy.username}
          onChange={(e) => setProxy({ ...proxy, username: e.target.value })}
        />
      </SettingRow>
      <SettingRow label="密码">
        <Input.Password
          style={{ width: 280 }}
          autoComplete="off"
          value={proxy.password}
          onChange={(e) => setProxy({ ...proxy, password: e.target.value })}
        />
      </SettingRow>
    </SectionCard>
  );
}

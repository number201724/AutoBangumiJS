/** 安全设置（对应 Vue 版 config-security）：CIDR 白名单标签列表。 */
import { Select, Typography } from 'antd';

import { useConfigGroup } from '@/stores/config';

import { SectionCard } from './section-card';
import { SettingRow } from './setting-row';

export function ConfigSecurity() {
  const [security, setSecurity] = useConfigGroup('security');

  return (
    <SectionCard title="安全设置">
      <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: 1.5 }}>
        登录白名单：为空则允许所有 IP。MCP 白名单：为空则拒绝所有访问。
      </Typography.Text>
      <SettingRow label="登录 IP 白名单">
        <Select
          mode="tags"
          style={{ width: 320, maxWidth: '100%' }}
          placeholder="192.168.0.0/16"
          value={security.login_whitelist}
          onChange={(v) => setSecurity({ ...security, login_whitelist: v })}
          open={false}
          suffixIcon={null}
        />
      </SettingRow>
      <SettingRow label="MCP IP 白名单">
        <Select
          mode="tags"
          style={{ width: 320, maxWidth: '100%' }}
          placeholder="127.0.0.0/8"
          value={security.mcp_whitelist}
          onChange={(v) => setSecurity({ ...security, mcp_whitelist: v })}
          open={false}
          suffixIcon={null}
        />
      </SettingRow>
    </SectionCard>
  );
}

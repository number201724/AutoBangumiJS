/** 网络设置（对应 Vue 版 config-network）。 */
import { Input } from 'antd';

import { useConfigGroup } from '@/stores/config';

import { SectionCard } from './section-card';
import { SettingRow } from './setting-row';

export function ConfigNetwork() {
  const [network, setNetwork] = useConfigGroup('network');

  return (
    <SectionCard title="网络设置">
      <SettingRow label="TMDB API 地址">
        <Input
          style={{ width: 320 }}
          placeholder="https://api.themoviedb.org"
          value={network.tmdb_base_url}
          onChange={(e) => setNetwork({ ...network, tmdb_base_url: e.target.value })}
        />
      </SettingRow>
      <SettingRow label="TMDB API Key（可选）">
        <Input.Password
          style={{ width: 320 }}
          autoComplete="off"
          value={network.tmdb_api_key}
          onChange={(e) => setNetwork({ ...network, tmdb_api_key: e.target.value })}
        />
      </SettingRow>
      <SettingRow label="Bangumi API 地址">
        <Input
          style={{ width: 320 }}
          placeholder="https://api.bgm.tv"
          value={network.bgm_base_url}
          onChange={(e) => setNetwork({ ...network, bgm_base_url: e.target.value })}
        />
      </SettingRow>
    </SectionCard>
  );
}

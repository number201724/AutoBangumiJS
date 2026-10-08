/**
 * 播放器设置（对应 Vue 版 config-player）。
 * 与 Vue 版共用 localStorage 键（media-player-type / media-player-url），
 * 播放器页面读取同样的键。
 */
import { useState } from 'react';
import { Input, Select } from 'antd';

import { SectionCard } from './section-card';
import { SettingRow } from './setting-row';

type MediaPlayerType = 'jump' | 'iframe';

const TYPE_KEY = 'media-player-type';
const URL_KEY = 'media-player-url';

function readType(): MediaPlayerType {
  return localStorage.getItem(TYPE_KEY) === 'iframe' ? 'iframe' : 'jump';
}

export function ConfigPlayer() {
  const [type, setType] = useState<MediaPlayerType>(readType);
  const [url, setUrl] = useState(() => localStorage.getItem(URL_KEY) ?? '');

  return (
    <SectionCard title="播放器设置">
      <SettingRow label="类型">
        <Select
          style={{ width: 240 }}
          value={type}
          onChange={(v) => {
            setType(v);
            localStorage.setItem(TYPE_KEY, v);
          }}
          options={[
            { label: 'jump', value: 'jump' },
            { label: 'iframe', value: 'iframe' },
          ]}
        />
      </SettingRow>
      <SettingRow label="播放器地址">
        <Input
          style={{ width: 320 }}
          placeholder="http://192.168.1.100:8096"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            localStorage.setItem(URL_KEY, e.target.value);
          }}
        />
      </SettingRow>
    </SectionCard>
  );
}

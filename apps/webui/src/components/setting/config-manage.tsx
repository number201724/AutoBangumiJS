/** 番剧管理设置（对应 Vue 版 config-manage）。 */
import { Select, Switch } from 'antd';

import { useConfigGroup } from '@/stores/config';

import { SectionCard } from './section-card';
import { SettingRow } from './setting-row';

export function ConfigManage() {
  const [manage, setManage] = useConfigGroup('bangumi_manage');

  return (
    <SectionCard title="番剧管理设置">
      <SettingRow label="启用">
        <Switch
          checked={manage.enable}
          onChange={(v) => setManage({ ...manage, enable: v })}
        />
      </SettingRow>
      <SettingRow label="重命名方式">
        <Select
          style={{ width: 240 }}
          value={manage.rename_method}
          onChange={(v) => setManage({ ...manage, rename_method: v })}
          options={[
            { label: 'normal', value: 'normal' },
            { label: 'pn', value: 'pn' },
            { label: 'advance', value: 'advance' },
            { label: 'none', value: 'none' },
          ]}
        />
      </SettingRow>
      <SettingRow
        label="修订版冲突处理"
        description="启用替换后，仅在更高修订版成功就位后删除旧种子及其数据。"
      >
        <Select
          style={{ width: 240 }}
          value={manage.revision_conflict_policy}
          onChange={(v) => setManage({ ...manage, revision_conflict_policy: v })}
          options={[
            { label: '保留现有文件', value: 'hold' },
            { label: '替换为更高修订版', value: 'replace' },
          ]}
        />
      </SettingRow>
      <SettingRow label="番剧补全">
        <Switch
          checked={manage.eps_complete}
          onChange={(v) => setManage({ ...manage, eps_complete: v })}
        />
      </SettingRow>
      <SettingRow label="添加组标签">
        <Switch
          checked={manage.group_tag}
          onChange={(v) => setManage({ ...manage, group_tag: v })}
        />
      </SettingRow>
      <SettingRow label="删除坏种">
        <Switch
          checked={manage.remove_bad_torrent}
          onChange={(v) => setManage({ ...manage, remove_bad_torrent: v })}
        />
      </SettingRow>
      <SettingRow label="记录未匹配种子">
        <Switch
          checked={manage.track_orphans}
          onChange={(v) => setManage({ ...manage, track_orphans: v })}
        />
      </SettingRow>
    </SectionCard>
  );
}

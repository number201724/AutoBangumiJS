/** 常规设置（对应 Vue 版 config-normal）。 */
import { InputNumber, Switch } from 'antd';

import { useConfigGroup } from '@/stores/config';

import { SectionCard } from './section-card';
import { SettingRow } from './setting-row';

export function ConfigNormal() {
  const [program, setProgram] = useConfigGroup('program');
  const [log, setLog] = useConfigGroup('log');

  return (
    <SectionCard title="常规设置">
      <SettingRow label="RSS 检查间隔（秒）">
        <InputNumber
          style={{ width: 180 }}
          min={0}
          placeholder="900"
          value={program.rss_time}
          onChange={(v) => setProgram({ ...program, rss_time: v ?? 0 })}
        />
      </SettingRow>
      <SettingRow label="重命名间隔（秒）">
        <InputNumber
          style={{ width: 180 }}
          min={0}
          placeholder="60"
          value={program.rename_time}
          onChange={(v) => setProgram({ ...program, rename_time: v ?? 0 })}
        />
      </SettingRow>
      <SettingRow label="网页端口">
        <InputNumber
          style={{ width: 180 }}
          min={1}
          max={65535}
          placeholder="7892"
          value={program.webui_port}
          onChange={(v) => setProgram({ ...program, webui_port: v ?? 0 })}
        />
      </SettingRow>
      <SettingRow label="调试">
        <Switch
          checked={log.debug_enable}
          onChange={(v) => setLog({ ...log, debug_enable: v })}
        />
      </SettingRow>
    </SectionCard>
  );
}

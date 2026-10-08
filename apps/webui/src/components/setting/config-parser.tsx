/** 解析设置（对应 Vue 版 config-parser）。 */
import { Select, Switch } from 'antd';

import { useConfigGroup } from '@/stores/config';

import { SectionCard } from './section-card';
import { SettingRow } from './setting-row';

export function ConfigParser() {
  const [parser, setParser] = useConfigGroup('rss_parser');

  return (
    <SectionCard title="解析设置">
      <SettingRow label="启用">
        <Switch
          checked={parser.enable}
          onChange={(v) => setParser({ ...parser, enable: v })}
        />
      </SettingRow>
      <SettingRow
        label="标题解析器"
        description="经典模式保持现有解析行为；Preview 支持剧集、OVA、剧场版、范围和混合合集。两种模式不会自动互相回退。"
      >
        <Select
          style={{ width: 240 }}
          value={parser.engine}
          onChange={(v) => setParser({ ...parser, engine: v })}
          options={[
            { label: '经典解析器（稳定）', value: 'classic' },
            { label: '通用解析器（Preview）', value: 'tokenizer' },
          ]}
        />
      </SettingRow>
      <SettingRow label="语言">
        <Select
          style={{ width: 240 }}
          value={parser.language}
          onChange={(v) => setParser({ ...parser, language: v })}
          options={[
            { label: 'zh', value: 'zh' },
            { label: 'zh-tw', value: 'zh-tw' },
            { label: 'en', value: 'en' },
            { label: 'jp', value: 'jp' },
          ]}
        />
      </SettingRow>
      <SettingRow label="排除">
        <Select
          mode="tags"
          style={{ width: 320, maxWidth: '100%' }}
          placeholder="输入后回车添加排除关键词"
          value={parser.filter}
          onChange={(v) => setParser({ ...parser, filter: v })}
          open={false}
          suffixIcon={null}
        />
      </SettingRow>
    </SectionCard>
  );
}

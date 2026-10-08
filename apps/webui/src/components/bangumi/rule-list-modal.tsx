/**
 * 多规则选择弹窗 — 同一 official_title + season 下有多条规则时，
 * 先列出规则让用户选择再进入编辑（移植 Vue calendar-rule-list-popup.vue /
 * bangumi.vue 内嵌的 rule list popup）。
 */
import { Modal, Tag, Typography } from 'antd';
import { RightOutlined } from '@ant-design/icons';
import type { Bangumi } from '@ab/types';

import type { BangumiGroup } from './utils';

interface RuleListModalProps {
  open: boolean;
  group: BangumiGroup | null;
  onSelect: (rule: Bangumi) => void;
  onClose: () => void;
}

export function RuleListModal({ open, group, onSelect, onClose }: RuleListModalProps) {
  return (
    <Modal
      open={open}
      title={group?.primary.official_title || ''}
      footer={null}
      onCancel={onClose}
      width={420}
    >
      {group && (
        <div>
          <Typography.Text
            type="secondary"
            style={{
              display: 'block',
              fontSize: 12,
              padding: '4px 12px 8px',
              borderBottom: '1px solid rgba(0,0,0,0.06)',
              marginBottom: 8,
            }}
          >
            该番剧有多个规则，请选择要编辑的规则：
          </Typography.Text>
          {group.rules.map((rule) => (
            <div
              key={rule.id}
              className={`bgm-rule-item${rule.deleted ? ' bgm-rule-item--disabled' : ''}${
                rule.needs_review ? ' bgm-rule-item--warning' : ''
              }`}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(rule)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSelect(rule);
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  {rule.needs_review && (
                    <span style={{ color: '#d97706', fontWeight: 700 }}>! </span>
                  )}
                  {rule.group_name || rule.rule_name || '未命名规则'}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                  {rule.dpi && <Tag color="blue">{rule.dpi}</Tag>}
                  {rule.subtitle && <Tag color="blue">{rule.subtitle}</Tag>}
                  {rule.source && <Tag color="blue">{rule.source}</Tag>}
                </div>
                {rule.filter && (
                  <div style={{ fontSize: 11, marginTop: 4 }}>
                    <Typography.Text type="secondary">过滤：</Typography.Text>
                    <Typography.Text type="secondary" code>
                      {rule.filter}
                    </Typography.Text>
                  </div>
                )}
                {rule.title_raw && (
                  <Typography.Text
                    type="secondary"
                    italic
                    style={{
                      display: 'block',
                      fontSize: 11,
                      marginTop: 4,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {rule.title_raw}
                  </Typography.Text>
                )}
              </div>
              <RightOutlined style={{ color: 'rgba(0,0,0,0.25)', marginTop: 2 }} />
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

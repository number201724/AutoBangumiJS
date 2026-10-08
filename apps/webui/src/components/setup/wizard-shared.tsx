/** 向导步骤共享布局 — 标题区 + 底部按钮行（对应 Vue 版 ab-container 标题与 wizard-actions）。 */
import type { ReactNode } from 'react';
import { Typography } from 'antd';

export function WizardHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 4 }}>
        {title}
      </Typography.Title>
      {subtitle && (
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          {subtitle}
        </Typography.Text>
      )}
    </div>
  );
}

export function WizardActions({ left, right }: { left?: ReactNode; right: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginTop: 24,
      }}
    >
      <div>{left}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{right}</div>
    </div>
  );
}

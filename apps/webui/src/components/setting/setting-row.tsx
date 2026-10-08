/** 设置行：左侧标签/说明，右侧控件（对应 Vue 版 ab-setting）。 */
import type { CSSProperties, ReactNode } from 'react';
import { theme } from 'antd';

interface SettingRowProps {
  label: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}

export function SettingRow({ label, description, children, style }: SettingRowProps) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
        ...style,
      }}
    >
      <div style={{ minWidth: 0, flex: '1 1 220px' }}>
        <div style={{ fontSize: 14 }}>{label}</div>
        {description ? (
          <div
            style={{
              fontSize: 12,
              color: token.colorTextSecondary,
              marginTop: 2,
              lineHeight: 1.5,
            }}
          >
            {description}
          </div>
        ) : null}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

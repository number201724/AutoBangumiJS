/** 设置分区卡片（对应 Vue 版 ab-fold-panel，React 版固定展开）。 */
import type { ReactNode } from 'react';
import { Card, Flex } from 'antd';

interface SectionCardProps {
  title: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
}

export function SectionCard({ title, extra, children }: SectionCardProps) {
  return (
    <Card title={title} extra={extra} size="small">
      <Flex vertical gap={12}>
        {children}
      </Flex>
    </Card>
  );
}

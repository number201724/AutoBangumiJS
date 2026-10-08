/** 欢迎步 — 对应 Vue 版 wizard-step-welcome.vue。 */
import { Button, Typography } from 'antd';

import { WizardActions, WizardHeader } from './wizard-shared';

export function WizardStepWelcome({ onNext }: { onNext: () => void }) {
  return (
    <div>
      <WizardHeader title="欢迎使用 AutoBangumi" />
      <Typography.Paragraph>让我们来设置你的自动追番系统。</Typography.Paragraph>
      <Typography.Paragraph type="secondary" style={{ fontSize: 13, lineHeight: 1.6 }}>
        本向导将引导你完成初始配置。你可以跳过可选步骤，稍后再进行配置。
      </Typography.Paragraph>
      <WizardActions
        right={
          <Button type="primary" onClick={onNext}>
            开始设置
          </Button>
        }
      />
    </div>
  );
}

/**
 * 账号步 — 对应 Vue 版 wizard-step-account.vue。
 * 校验规则（AntD Form rules）：用户名必填、4-20 位 [a-zA-Z0-9_]；密码必填、≥8 位；确认密码需一致。
 */
import { Button, Form, Input } from 'antd';

import type { AccountData } from './types';
import { WizardActions, WizardHeader } from './wizard-shared';

interface Props {
  data: AccountData;
  onChange: (data: AccountData) => void;
  onNext: () => void;
  onPrev: () => void;
}

export function WizardStepAccount({ data, onChange, onNext, onPrev }: Props) {
  const [form] = Form.useForm<AccountData>();

  async function handleNext() {
    try {
      const values = await form.validateFields();
      onChange(values);
      onNext();
    } catch {
      /* 校验失败 — 错误信息已由 Form.Item 展示 */
    }
  }

  return (
    <div>
      <WizardHeader title="创建账户" subtitle="为了安全，请修改默认登录凭证。" />
      <Form
        form={form}
        layout="vertical"
        initialValues={data}
        onValuesChange={(_, values) => onChange(values)}
      >
        <Form.Item
          name="username"
          label="用户名"
          rules={[
            { required: true, message: '请输入用户名' },
            { min: 4, message: '用户名长度不能少于 4 个字符' },
            { max: 20, message: '用户名长度不能超过 20 个字符' },
            { pattern: /^[a-zA-Z0-9_]+$/, message: '用户名只能包含字母、数字和下划线' },
          ]}
        >
          <Input placeholder="admin" autoComplete="username" />
        </Form.Item>
        <Form.Item
          name="password"
          label="密码"
          rules={[
            { required: true, message: '请输入密码' },
            { min: 8, message: '密码长度不能少于 8 个字符' },
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="confirmPassword"
          label="确认密码"
          dependencies={['password']}
          rules={[
            { required: true, message: '请再次输入密码' },
            ({ getFieldValue }) => ({
              validator(_, value: string) {
                if (!value || getFieldValue('password') === value) {
                  return Promise.resolve();
                }
                return Promise.reject(new Error('两次输入的密码不一致'));
              },
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
      <WizardActions
        left={<Button onClick={onPrev}>上一步</Button>}
        right={
          <Button type="primary" onClick={() => void handleNext()}>
            下一步
          </Button>
        }
      />
    </div>
  );
}

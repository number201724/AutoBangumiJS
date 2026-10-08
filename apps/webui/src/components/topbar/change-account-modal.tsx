/**
 * Change-account modal — mirrors components/ab-change-account.vue
 * (current-account username/password change via POST /auth/update).
 */
import { useState } from 'react';
import { Form, Input, Modal, message } from 'antd';

import { api } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

export function ChangeAccountModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { username, setUsername, logout } = useAuthStore();
  const [form] = Form.useForm<{ username: string; password: string; confirm: string }>();
  const [loading, setLoading] = useState(false);

  async function onOk() {
    const values = await form.validateFields();
    setLoading(true);
    try {
      await api.post('api/v1/auth/update', {
        username: values.username,
        password: values.password,
      });
      void message.success('账号已更新');
      setUsername(values.username);
      onClose();
      form.resetFields();
    } catch {
      /* interceptor toasts */
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      title="修改账号"
      open={open}
      onOk={() => void onOk()}
      onCancel={onClose}
      confirmLoading={loading}
      okText="保存"
      cancelText="取消"
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ username }}
        style={{ marginTop: 16 }}
      >
        <Form.Item
          name="username"
          label="用户名"
          rules={[
            { required: true, message: '请输入用户名' },
            { pattern: /^[a-zA-Z0-9_]{4,20}$/, message: '4-20 位字母、数字或下划线' },
          ]}
        >
          <Input autoComplete="username" />
        </Form.Item>
        <Form.Item
          name="password"
          label="新密码"
          rules={[
            { required: true, message: '请输入新密码' },
            { min: 8, message: '密码至少 8 位' },
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="confirm"
          label="确认新密码"
          dependencies={['password']}
          rules={[
            { required: true, message: '请再次输入新密码' },
            ({ getFieldValue }) => ({
              validator: (_, value) =>
                value === getFieldValue('password')
                  ? Promise.resolve()
                  : Promise.reject(new Error('两次输入的密码不一致')),
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <div style={{ color: '#999', fontSize: 12 }}>
          保存后所有已有会话将被吊销。如果忘记密码，可以
          <a onClick={() => void logout()}>退出登录</a>
          后重新登录。
        </div>
      </Form>
    </Modal>
  );
}

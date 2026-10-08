/**
 * Login page — password + passkey (React/AntD port of pages/login.vue).
 */
import { useEffect, useState } from 'react';
import { Button, Card, Form, Input } from 'antd';
import { KeyOutlined, LockOutlined, UserOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';

import { api } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import {
  hasKnownPasskey,
  isPasskeySupported,
  loginWithPasskey,
} from '@/api/passkey';

export function LoginPage() {
  const navigate = useNavigate();
  const { setLoggedIn, setUsername: setAuthUsername } = useAuthStore();
  const [username, setUsername] = useState('');
  const [isLoginLoading, setIsLoginLoading] = useState(false);
  const [isPasskeyLoading, setIsPasskeyLoading] = useState(false);

  async function handlePasskeyLogin(silent = false) {
    if (isPasskeyLoading) return;
    setIsPasskeyLoading(true);
    try {
      const ok = await loginWithPasskey(username || undefined, { silent });
      if (ok) {
        setLoggedIn(true);
        navigate('/bangumi', { replace: true });
      }
    } finally {
      setIsPasskeyLoading(false);
    }
  }

  // 本浏览器成功用过 passkey：打开登录页时自动弹出认证；用户取消则静默回落
  useEffect(() => {
    if (sessionStorage.getItem('suppressPasskeyAutoPrompt')) {
      sessionStorage.removeItem('suppressPasskeyAutoPrompt');
      return;
    }
    if (isPasskeySupported() && hasKnownPasskey()) {
      void handlePasskeyLogin(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleLogin(values: { username: string; password: string }) {
    if (isLoginLoading) return;
    setIsLoginLoading(true);
    try {
      const formData = new URLSearchParams({
        username: values.username,
        password: values.password,
      });
      await api.post('api/v1/auth/login', formData, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      setLoggedIn(true);
      setAuthUsername(values.username);
      navigate('/bangumi', { replace: true });
    } finally {
      setIsLoginLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      }}
    >
      <Card style={{ width: 360, boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, margin: 0 }}>AutoBangumi</h1>
          <p style={{ color: '#888', marginTop: 8 }}>全自动追番整理</p>
        </div>
        <Form onFinish={handleLogin} size="large">
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input
              prefix={<UserOutlined />}
              placeholder="用户名"
              autoComplete="username"
              onChange={(e) => setUsername(e.target.value)}
            />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="密码"
              autoComplete="current-password"
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 12 }}>
            <Button type="primary" htmlType="submit" block loading={isLoginLoading}>
              登录
            </Button>
          </Form.Item>
          {isPasskeySupported() && (
            <Button
              block
              icon={<KeyOutlined />}
              loading={isPasskeyLoading}
              onClick={() => void handlePasskeyLogin()}
            >
              使用 Passkey 登录
            </Button>
          )}
        </Form>
      </Card>
    </div>
  );
}

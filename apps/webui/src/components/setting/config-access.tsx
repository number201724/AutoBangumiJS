/**
 * 账号与访问控制（对应 Vue 版 config-access + 顶栏"修改账户"）。
 * - 当前账号改用户名/密码：直接调 POST /auth/update（会话会轮换，无需重新登录）
 * - 多用户 CRUD：apiUsers
 * - API Token：apiTokens，创建成功展示一次性明文
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  DatePicker,
  Divider,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
  message,
  theme,
} from 'antd';
import type { Dayjs } from 'dayjs';
import type { ApiTokenPublic, UserPublic } from '@ab/types';

import { api } from '@/api/client';
import { apiTokens, apiUsers } from '@/api/users';
import { useAuthStore } from '@/stores/auth';

import { SectionCard } from './section-card';
import { SettingRow } from './setting-row';

// SQLite 往返会丢时区，但后端按 UTC 存储/比较；无偏移量时按 UTC 解析
const TIMEZONE_SUFFIX = /(?:z|[+-]\d{2}:\d{2})$/i;

function parseApiTimestamp(value: string): number {
  return Date.parse(TIMEZONE_SUFFIX.test(value) ? value : `${value}Z`);
}

function formatDate(value: string | null): string {
  if (!value) return '从未';
  const timestamp = parseApiTimestamp(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}

type TokenStatus = 'active' | 'expired' | 'revoked';

function tokenStatus(token: ApiTokenPublic): TokenStatus {
  if (token.revoked_at !== null) return 'revoked';
  if (token.expires_at !== null) {
    const expiresAt = parseApiTimestamp(token.expires_at);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return 'expired';
  }
  return 'active';
}

const STATUS_LABEL: Record<TokenStatus, string> = {
  active: '有效',
  expired: '已过期',
  revoked: '已撤销',
};

const STATUS_COLOR: Record<TokenStatus, string> = {
  active: 'blue',
  expired: 'orange',
  revoked: 'default',
};

export function ConfigAccess() {
  const authUsername = useAuthStore((s) => s.username);
  const { token: themeToken } = theme.useToken();

  // --- 当前账号 ---------------------------------------------------------------
  const [accountUsername, setAccountUsername] = useState(authUsername);
  const [accountPassword, setAccountPassword] = useState('');
  const [accountPassword2, setAccountPassword2] = useState('');
  const [accountSubmitting, setAccountSubmitting] = useState(false);

  useEffect(() => {
    setAccountUsername(authUsername);
  }, [authUsername]);

  const accountValid =
    !!accountUsername.trim() &&
    accountPassword.length >= 8 &&
    accountPassword === accountPassword2;

  async function handleUpdateAccount() {
    if (!accountValid) return;
    setAccountSubmitting(true);
    try {
      await api.post('api/v1/auth/update', {
        username: accountUsername.trim(),
        password: accountPassword,
      });
      useAuthStore.getState().setUsername(accountUsername.trim());
      setAccountPassword('');
      setAccountPassword2('');
      void message.success('账号已更新');
    } finally {
      setAccountSubmitting(false);
    }
  }

  // --- 用户 / 令牌列表 ---------------------------------------------------------
  const [users, setUsers] = useState<UserPublic[]>([]);
  const [tokens, setTokens] = useState<ApiTokenPublic[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const [userList, tokenList] = await Promise.all([apiUsers.list(), apiTokens.list()]);
      setUsers(userList);
      setTokens(tokenList);
    } finally {
      setLoading(false);
    }
  }

  const ownerByUserId = useMemo(
    () => new Map(users.map((user) => [user.id, user.username])),
    [users],
  );

  // --- 添加用户 ---------------------------------------------------------------
  const [showUserDialog, setShowUserDialog] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleCreateUser() {
    if (!newUsername.trim() || newPassword.length < 8) return;
    setSubmitting(true);
    try {
      await apiUsers.create(newUsername.trim(), newPassword);
      setShowUserDialog(false);
      setNewUsername('');
      setNewPassword('');
      void message.success('用户已创建');
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleUser(user: UserPublic) {
    await apiUsers.update(user.id, { enabled: !user.enabled });
    await load();
  }

  async function deleteUser(user: UserPublic) {
    await apiUsers.delete(user.id);
    await load();
  }

  // --- 创建令牌 ---------------------------------------------------------------
  const [showTokenDialog, setShowTokenDialog] = useState(false);
  const [tokenName, setTokenName] = useState('');
  const [tokenScope, setTokenScope] = useState<'api' | 'mcp'>('api');
  const [tokenExpiresAt, setTokenExpiresAt] = useState<Dayjs | null>(null);
  const [issuedToken, setIssuedToken] = useState('');

  async function handleCreateToken() {
    if (!tokenName.trim()) return;
    setSubmitting(true);
    try {
      const created = await apiTokens.create(
        tokenName.trim(),
        tokenScope,
        tokenExpiresAt ? tokenExpiresAt.toISOString() : null,
      );
      setIssuedToken(created.token);
      setShowTokenDialog(false);
      setTokenName('');
      setTokenExpiresAt(null);
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  async function copyIssuedToken() {
    await navigator.clipboard.writeText(issuedToken);
    void message.success('令牌已复制');
  }

  async function revokeToken(tokenId: number) {
    await apiTokens.revoke(tokenId);
    await load();
  }

  return (
    <SectionCard title="用户与访问控制">
      {/* 当前账号 */}
      <SettingRow label="当前账号用户名">
        <Input
          style={{ width: 280 }}
          autoComplete="off"
          value={accountUsername}
          onChange={(e) => setAccountUsername(e.target.value)}
        />
      </SettingRow>
      <SettingRow label="新密码" description="密码长度必须至少为 8 个字符">
        <Input.Password
          style={{ width: 280 }}
          autoComplete="new-password"
          value={accountPassword}
          onChange={(e) => setAccountPassword(e.target.value)}
        />
      </SettingRow>
      <SettingRow label="确认新密码">
        <Input.Password
          style={{ width: 280 }}
          autoComplete="new-password"
          value={accountPassword2}
          status={accountPassword2 && accountPassword !== accountPassword2 ? 'error' : ''}
          onChange={(e) => setAccountPassword2(e.target.value)}
        />
      </SettingRow>
      {accountPassword2 && accountPassword !== accountPassword2 ? (
        <Typography.Text type="danger" style={{ fontSize: 12 }}>
          两次输入的密码不一致
        </Typography.Text>
      ) : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          type="primary"
          size="small"
          loading={accountSubmitting}
          disabled={!accountValid}
          onClick={() => void handleUpdateAccount()}
        >
          更新账号
        </Button>
      </div>

      <Divider style={{ margin: '8px 0' }} />

      {/* 用户列表 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 500 }}>用户</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            所有启用用户拥有相同权限。
          </Typography.Text>
        </div>
        <Button size="small" onClick={() => setShowUserDialog(true)}>
          添加用户
        </Button>
      </div>

      {loading ? (
        <Spin size="small" />
      ) : (
        users.map((user) => (
          <div
            key={user.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
              padding: '10px 12px',
              border: `1px solid ${themeToken.colorBorderSecondary}`,
              borderRadius: 6,
            }}
          >
            <Space>
              <strong>{user.username}</strong>
              <Tag color={user.enabled ? 'blue' : 'default'}>
                {user.enabled ? '已启用' : '已禁用'}
              </Tag>
            </Space>
            <Space>
              <Switch
                checked={user.enabled}
                aria-label={`切换 ${user.username} 状态`}
                onChange={() => void toggleUser(user)}
              />
              <Popconfirm
                title={`确认删除 ${user.username}？`}
                okText="删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                onConfirm={() => void deleteUser(user)}
              >
                <Button size="small" danger>
                  删除
                </Button>
              </Popconfirm>
            </Space>
          </div>
        ))
      )}

      <Divider style={{ margin: '8px 0' }} />

      {/* API 令牌 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 500 }}>API 令牌</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            令牌仅以哈希保存，明文只显示一次。
          </Typography.Text>
        </div>
        <Button size="small" onClick={() => setShowTokenDialog(true)}>
          创建令牌
        </Button>
      </div>

      {loading ? (
        <Spin size="small" />
      ) : tokens.length === 0 ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          暂无令牌
        </Typography.Text>
      ) : (
        tokens.map((token) => {
          const status = tokenStatus(token);
          return (
            <div
              key={token.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
                padding: '10px 12px',
                border: `1px solid ${themeToken.colorBorderSecondary}`,
                borderRadius: 6,
              }}
            >
              <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Space>
                  <strong>{token.name}</strong>
                  <Tag>{token.scope.toUpperCase()}</Tag>
                  <Tag color={STATUS_COLOR[status]}>{STATUS_LABEL[status]}</Tag>
                </Space>
                <Typography.Text type="secondary" code style={{ width: 'fit-content' }}>
                  {token.prefix}…
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  所属用户: {ownerByUserId.get(token.user_id) ?? '未知用户'}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  上次使用: {formatDate(token.last_used_at)}
                </Typography.Text>
                {token.expires_at ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    过期时间: {formatDate(token.expires_at)}
                  </Typography.Text>
                ) : null}
              </div>
              {status !== 'revoked' ? (
                <Popconfirm
                  title="确认撤销此令牌？"
                  okText="撤销"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  onConfirm={() => void revokeToken(token.id)}
                >
                  <Button size="small" danger>
                    撤销
                  </Button>
                </Popconfirm>
              ) : null}
            </div>
          );
        })
      )}

      {/* 添加用户对话框 */}
      <Modal
        open={showUserDialog}
        title="添加用户"
        onCancel={() => {
          setShowUserDialog(false);
          setNewUsername('');
          setNewPassword('');
        }}
        footer={
          <>
            <Button
              onClick={() => {
                setShowUserDialog(false);
                setNewUsername('');
                setNewPassword('');
              }}
            >
              取消
            </Button>
            <Button
              type="primary"
              loading={submitting}
              disabled={!newUsername.trim() || newPassword.length < 8}
              onClick={() => void handleCreateUser()}
            >
              创建
            </Button>
          </>
        }
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <div>
            <div style={{ marginBottom: 6 }}>用户名</div>
            <Input
              maxLength={20}
              autoComplete="off"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
            />
          </div>
          <div>
            <div style={{ marginBottom: 6 }}>密码（至少 8 个字符）</div>
            <Input.Password
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
        </Space>
      </Modal>

      {/* 创建令牌对话框 */}
      <Modal
        open={showTokenDialog}
        title="创建令牌"
        onCancel={() => {
          setShowTokenDialog(false);
          setTokenName('');
          setTokenExpiresAt(null);
        }}
        footer={
          <>
            <Button
              onClick={() => {
                setShowTokenDialog(false);
                setTokenName('');
                setTokenExpiresAt(null);
              }}
            >
              取消
            </Button>
            <Button
              type="primary"
              loading={submitting}
              disabled={!tokenName.trim()}
              onClick={() => void handleCreateToken()}
            >
              创建
            </Button>
          </>
        }
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <div>
            <div style={{ marginBottom: 6 }}>令牌名称</div>
            <Input
              maxLength={64}
              value={tokenName}
              onChange={(e) => setTokenName(e.target.value)}
            />
          </div>
          <div>
            <div style={{ marginBottom: 6 }}>作用域</div>
            <Select
              style={{ width: 200 }}
              value={tokenScope}
              onChange={(v) => setTokenScope(v)}
              options={[
                { label: 'API', value: 'api' },
                { label: 'MCP', value: 'mcp' },
              ]}
            />
          </div>
          <div>
            <div style={{ marginBottom: 6 }}>过期时间（可选）</div>
            <DatePicker
              showTime
              style={{ width: '100%' }}
              value={tokenExpiresAt}
              onChange={(v) => setTokenExpiresAt(v)}
            />
          </div>
        </Space>
      </Modal>

      {/* 一次性令牌展示 */}
      <Modal
        open={!!issuedToken}
        title="令牌已创建"
        onCancel={() => setIssuedToken('')}
        footer={
          <Button type="primary" onClick={() => void copyIssuedToken()}>
            复制
          </Button>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="danger">请立即复制此令牌，之后无法再次显示。</Typography.Text>
          <Typography.Paragraph
            code
            copyable={{ text: issuedToken }}
            aria-label="一次性令牌"
            style={{ wordBreak: 'break-all', marginBottom: 0 }}
          >
            {issuedToken}
          </Typography.Paragraph>
        </Space>
      </Modal>
    </SectionCard>
  );
}

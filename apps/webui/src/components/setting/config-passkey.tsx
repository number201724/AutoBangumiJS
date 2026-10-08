/** Passkey 设置（对应 Vue 版 config-passkey）：列表 + 注册 + 删除。 */
import { useEffect, useState } from 'react';
import { Button, Input, Modal, Popconfirm, Space, Spin, Tag, Typography, message, theme } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';

import { isPasskeySupported, registerPasskey } from '@/api/passkey';
import { apiPasskeyManage, type PasskeyItem } from '@/api/passkey-manage';

import { SectionCard } from './section-card';

function formatDate(dateString: string | null): string {
  if (!dateString) return '-';
  return new Date(dateString).toLocaleString();
}

/** 根据 UA 生成默认设备名（与 Vue 版一致） */
function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (ua.includes('iPhone')) return 'iPhone';
  if (ua.includes('iPad')) return 'iPad';
  if (ua.includes('Mac')) return 'MacBook';
  if (ua.includes('Windows')) return 'Windows PC';
  if (ua.includes('Android')) return 'Android';
  return navigator.platform || 'Device';
}

export function ConfigPasskey() {
  const [passkeys, setPasskeys] = useState<PasskeyItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const isSupported = isPasskeySupported();
  const { token } = theme.useToken();

  useEffect(() => {
    void loadPasskeys();
  }, []);

  async function loadPasskeys() {
    setLoading(true);
    try {
      setPasskeys(await apiPasskeyManage.list());
    } catch {
      // 拦截器已提示
    } finally {
      setLoading(false);
    }
  }

  function openAddDialog() {
    setDeviceName(defaultDeviceName());
    setShowAddDialog(true);
  }

  async function handleAdd() {
    const name = deviceName.trim();
    if (!name) return;
    setIsRegistering(true);
    try {
      await registerPasskey(name);
      void message.success('Passkey 注册成功');
      setShowAddDialog(false);
      setDeviceName('');
      await loadPasskeys();
    } catch (error: unknown) {
      // API 错误由 axios 拦截器提示；这里只补充 WebAuthn 仪式本身的错误
      if (error && typeof error === 'object' && 'status' in error) return;
      const detail = error instanceof Error ? error.message : String(error);
      void message.error(`注册失败: ${detail}`);
    } finally {
      setIsRegistering(false);
    }
  }

  async function handleDelete(passkey: PasskeyItem) {
    try {
      await apiPasskeyManage.delete(passkey.id);
      void message.success('Passkey 已删除');
      await loadPasskeys();
    } catch {
      void message.error('删除失败');
    }
  }

  return (
    <SectionCard title="Passkey 设置">
      {!isSupported ? (
        <Typography.Text type="warning">您的浏览器不支持 Passkey</Typography.Text>
      ) : loading ? (
        <Spin size="small" />
      ) : passkeys.length === 0 ? (
        <Typography.Text type="secondary">尚未注册任何 Passkey</Typography.Text>
      ) : (
        passkeys.map((passkey) => (
          <div
            key={passkey.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: 12,
              background: token.colorFillTertiary,
              borderRadius: 8,
            }}
          >
            <div>
              <div style={{ fontWeight: 500 }}>{passkey.name}</div>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                创建于: {formatDate(passkey.created_at)}
              </Typography.Text>
              {passkey.last_used_at ? (
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                  最后使用: {formatDate(passkey.last_used_at)}
                </Typography.Text>
              ) : null}
              {passkey.backup_eligible ? (
                <Tag color="green" style={{ marginTop: 4 }}>
                  已同步到多设备
                </Tag>
              ) : null}
            </div>
            <Popconfirm
              title="确定删除此 Passkey？"
              okText="删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() => void handleDelete(passkey)}
            >
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          </div>
        ))
      )}

      {isSupported ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openAddDialog}>
            添加 Passkey
          </Button>
        </div>
      ) : null}

      <Modal
        open={showAddDialog}
        title="添加新的 Passkey"
        onCancel={() => setShowAddDialog(false)}
        footer={
          <>
            <Button onClick={() => setShowAddDialog(false)}>取消</Button>
            <Button
              type="primary"
              disabled={!deviceName.trim() || isRegistering}
              loading={isRegistering}
              onClick={() => void handleAdd()}
            >
              应用
            </Button>
          </>
        }
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <div>
            <div style={{ marginBottom: 6 }}>设备名称</div>
            <Input
              maxLength={64}
              placeholder="例如：iPhone 15, MacBook Pro"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              onPressEnter={() => void handleAdd()}
            />
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            点击确认后，请按照浏览器提示完成身份验证。
          </Typography.Text>
        </Space>
      </Modal>
    </SectionCard>
  );
}

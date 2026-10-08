/**
 * 通知设置（对应 Vue 版 config-notification）。
 * providers 列表编辑的是 Config 工作副本（随底部"保存全部"提交）；
 * "测试"直接用 test-config 发送当前未保存的配置。
 */
import { useState } from 'react';
import {
  Alert,
  Button,
  Divider,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tag,
  theme,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlayCircleOutlined, PlusOutlined } from '@ant-design/icons';
import type { NotificationProviderConfig } from '@ab/types';

import { apiNotification } from '@/api/notification';
import { useConfigGroup } from '@/stores/config';

import { SectionCard } from './section-card';
import { SettingRow } from './setting-row';

const PROVIDER_TYPES = [
  { value: 'telegram', label: 'Telegram' },
  { value: 'discord', label: 'Discord' },
  { value: 'bark', label: 'Bark' },
  { value: 'server-chan', label: 'Server Chan' },
  { value: 'wecom', label: 'WeChat Work' },
  { value: 'gotify', label: 'Gotify' },
  { value: 'pushover', label: 'Pushover' },
  { value: 'webhook', label: 'Webhook' },
];

interface ProviderField {
  key: keyof NotificationProviderConfig;
  label: string;
  placeholder: string;
  multiline?: boolean;
}

const PROVIDER_FIELDS: Record<string, ProviderField[]> = {
  telegram: [
    { key: 'token', label: 'Bot Token', placeholder: 'bot token' },
    { key: 'chat_id', label: 'Chat ID', placeholder: 'chat id' },
  ],
  discord: [
    {
      key: 'webhook_url',
      label: 'Webhook URL',
      placeholder: 'https://discord.com/api/webhooks/...',
    },
  ],
  bark: [
    { key: 'device_key', label: 'Device Key', placeholder: 'device key' },
    { key: 'server_url', label: 'Server URL (optional)', placeholder: 'https://api.day.app' },
  ],
  'server-chan': [{ key: 'token', label: 'SendKey', placeholder: 'sendkey' }],
  wecom: [
    { key: 'webhook_url', label: 'Webhook URL', placeholder: 'webhook url' },
    { key: 'token', label: 'Key', placeholder: 'key' },
  ],
  gotify: [
    { key: 'server_url', label: 'Server URL', placeholder: 'https://gotify.example.com' },
    { key: 'token', label: 'App Token', placeholder: 'app token' },
  ],
  pushover: [
    { key: 'user_key', label: 'User Key', placeholder: 'user key' },
    { key: 'api_token', label: 'API Token', placeholder: 'api token' },
  ],
  webhook: [
    { key: 'url', label: 'Webhook URL', placeholder: 'https://example.com/webhook' },
    {
      key: 'template',
      label: 'Template (JSON)',
      placeholder: '{"title": "{{title}}", "episode": {{episode}}}',
      multiline: true,
    },
  ],
};

interface TestOutcome {
  success: boolean;
  message: string;
}

function providerLabel(type: string): string {
  return PROVIDER_TYPES.find((p) => p.value === type)?.label ?? type;
}

export function ConfigNotification() {
  const [notification, setNotification] = useConfigGroup('notification');
  const { token } = theme.useToken();

  const providers = notification.providers ?? [];
  const setProviders = (list: NotificationProviderConfig[]) =>
    setNotification({ ...notification, providers: list });

  // 添加/编辑对话框：editingIndex === -1 表示新增
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState(-1);
  const [form, setForm] = useState<NotificationProviderConfig>({ type: 'telegram', enabled: true });
  const [dialogTesting, setDialogTesting] = useState(false);
  const [dialogResult, setDialogResult] = useState<TestOutcome | null>(null);

  // 列表项测试
  const [testingIndex, setTestingIndex] = useState(-1);
  const [listResult, setListResult] = useState<TestOutcome | null>(null);

  async function runTest(config: NotificationProviderConfig): Promise<TestOutcome> {
    try {
      const res = await apiNotification.testConfig(config);
      return {
        success: res.success,
        message: res.message_zh || res.message_en || res.message,
      };
    } catch {
      return { success: false, message: '测试失败' };
    }
  }

  async function testProvider(index: number) {
    const target = providers[index];
    if (!target) return;
    setTestingIndex(index);
    setListResult(null);
    try {
      // Vue 原版语义：列表项测的是**已保存的真实配置**（provider_index），
      // 草稿里的 token 是后端掩码 '********'，不能当真实凭据发送
      const res = await apiNotification.test(index);
      setListResult({
        success: res.success,
        message: res.message_zh || res.message_en || res.message,
      });
    } catch {
      setListResult({ success: false, message: '测试失败' });
    } finally {
      setTestingIndex(-1);
    }
  }

  async function testForm() {
    setDialogTesting(true);
    setDialogResult(null);
    try {
      setDialogResult(await runTest(form));
    } finally {
      setDialogTesting(false);
    }
  }

  function openAdd() {
    setEditingIndex(-1);
    setForm({ type: 'telegram', enabled: true });
    setDialogResult(null);
    setDialogOpen(true);
  }

  function openEdit(index: number) {
    const target = providers[index];
    if (!target) return;
    setEditingIndex(index);
    setForm({ ...target });
    setDialogResult(null);
    setDialogOpen(true);
  }

  function applyForm() {
    if (editingIndex >= 0) {
      const next = [...providers];
      next[editingIndex] = { ...form };
      setProviders(next);
    } else {
      setProviders([...providers, { ...form }]);
    }
    setDialogOpen(false);
  }

  function toggleProvider(index: number) {
    const target = providers[index];
    if (!target) return;
    const next = [...providers];
    next[index] = { ...target, enabled: !target.enabled };
    setProviders(next);
  }

  function removeProvider(index: number) {
    setProviders(providers.filter((_, i) => i !== index));
  }

  function setField(field: ProviderField, value: string) {
    setForm({ ...form, [field.key]: value });
  }

  const fields = PROVIDER_FIELDS[form.type] ?? [];

  return (
    <SectionCard title="通知设置">
      <SettingRow label="启用">
        <Switch
          checked={notification.enable}
          onChange={(v) => setNotification({ ...notification, enable: v })}
        />
      </SettingRow>

      {notification.enable ? (
        <>
          <SettingRow
            label="通知 Base URL"
            description="用于拼接通知中海报图片的公开访问地址，留空则不附带图片。"
          >
            <Input
              style={{ width: 320 }}
              placeholder="https://ab.example.com"
              value={notification.base_url}
              onChange={(e) => setNotification({ ...notification, base_url: e.target.value })}
            />
          </SettingRow>

          {providers.map((provider, index) => (
            <div
              key={index}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
                padding: 12,
                background: token.colorFillTertiary,
                borderRadius: 8,
                opacity: provider.enabled ? 1 : 0.5,
              }}
            >
              <div style={{ fontWeight: 500, fontSize: 14 }}>
                {providerLabel(provider.type)}
                {!provider.enabled ? (
                  <Tag color="red" style={{ marginLeft: 8 }}>
                    已禁用
                  </Tag>
                ) : null}
              </div>
              <Space wrap>
                <Button
                  size="small"
                  icon={<PlayCircleOutlined />}
                  loading={testingIndex === index}
                  onClick={() => void testProvider(index)}
                >
                  测试
                </Button>
                <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(index)}>
                  编辑
                </Button>
                <Button size="small" onClick={() => toggleProvider(index)}>
                  {provider.enabled ? '禁用' : '启用'}
                </Button>
                <Popconfirm
                  title="确定删除此通知服务？"
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  onConfirm={() => removeProvider(index)}
                >
                  <Button size="small" danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            </div>
          ))}

          {listResult ? (
            <Alert
              type={listResult.success ? 'success' : 'error'}
              showIcon
              message={listResult.message}
            />
          ) : null}

          <Divider style={{ margin: '4px 0' }} />

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openAdd}>
              添加通知服务
            </Button>
          </div>
        </>
      ) : null}

      <Modal
        open={dialogOpen}
        title={editingIndex >= 0 ? '编辑通知服务' : '添加通知服务'}
        onCancel={() => setDialogOpen(false)}
        footer={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              style={{ marginRight: 'auto' }}
              icon={<PlayCircleOutlined />}
              loading={dialogTesting}
              onClick={() => void testForm()}
            >
              测试
            </Button>
            <Button onClick={() => setDialogOpen(false)}>取消</Button>
            <Button type="primary" onClick={applyForm}>
              应用
            </Button>
          </div>
        }
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <div>
            <div style={{ marginBottom: 6 }}>类型</div>
            <Select
              style={{ width: 200, maxWidth: '100%' }}
              value={form.type}
              disabled={editingIndex >= 0}
              onChange={(v) => setForm({ type: v, enabled: true })}
              options={PROVIDER_TYPES}
            />
          </div>

          {fields.map((field) => (
            <div key={field.key}>
              <div style={{ marginBottom: 6 }}>{field.label}</div>
              {field.multiline ? (
                <Input.TextArea
                  rows={3}
                  placeholder={field.placeholder}
                  value={String(form[field.key] ?? '')}
                  onChange={(e) => setField(field, e.target.value)}
                  style={{ fontFamily: 'monospace', fontSize: 13 }}
                />
              ) : (
                <Input
                  placeholder={field.placeholder}
                  value={String(form[field.key] ?? '')}
                  onChange={(e) => setField(field, e.target.value)}
                />
              )}
            </div>
          ))}

          {dialogResult ? (
            <Alert
              type={dialogResult.success ? 'success' : 'error'}
              showIcon
              message={dialogResult.message}
            />
          ) : null}
        </Space>
      </Modal>
    </SectionCard>
  );
}

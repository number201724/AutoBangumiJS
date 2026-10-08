/**
 * 搜索源设置（对应 Vue 版 config-search-provider）。
 * 自持久化分区：每次增删改后立即 PUT 到后端，不参与全局保存。
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Space,
  Spin,
  Tag,
  Typography,
  message,
  theme,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';

import { apiSearch } from '@/api/search';

import { SectionCard } from './section-card';

interface SearchProvider {
  name: string;
  url: string;
}

type AddMode = 'custom' | 'nexusphp';

/** 内置默认源不可删除/改名 */
const DEFAULT_PROVIDER_NAMES = ['mikan', 'anibt', 'nyaa', 'dmhy'];

// --- NexusPHP PT 站点 URL 模板构造（移植自 Vue 版 utils/nexusphp）-------------

function parseCategoryIds(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 分类 ID 输入校验：空 = 不过滤；否则每个逗号分隔段都必须是纯数字 */
function isValidNexusPhpCategoryIds(input: string): boolean {
  return parseCategoryIds(input).every((id) => /^\d+$/.test(id));
}

function buildNexusPhpSearchUrl(baseUrl: string, passkey: string, categoryId: string): string {
  let base = baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) {
    base = `https://${base}`;
  }
  const key = encodeURIComponent(passkey.trim());
  const catParams = parseCategoryIds(categoryId)
    .map((id) => `&cat${encodeURIComponent(id)}=1`)
    .join('');
  return `${base}/torrentrss.php?rows=50&linktype=dl&passkey=${key}${catParams}&search=%s`;
}

function validateUrl(url: string): boolean {
  return url.includes('%s');
}

export function ConfigSearchProvider() {
  const [providers, setProviders] = useState<SearchProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const { token } = theme.useToken();

  // 对话框状态：editingIndex === -1 表示新增
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState(-1);
  const [formName, setFormName] = useState('');
  const [formUrl, setFormUrl] = useState('');
  // 添加对话框的 NexusPHP 预设模式
  const [formMode, setFormMode] = useState<AddMode>('custom');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formPasskey, setFormPasskey] = useState('');
  const [formCategoryId, setFormCategoryId] = useState('');

  useEffect(() => {
    void loadProviders();
  }, []);

  async function loadProviders() {
    setLoading(true);
    try {
      const data = await apiSearch.getProviderConfig();
      setProviders(Object.entries(data).map(([name, url]) => ({ name, url })));
    } catch {
      void message.error('加载搜索源失败');
    } finally {
      setLoading(false);
    }
  }

  async function saveProviders(next: SearchProvider[]) {
    const providerObj: Record<string, string> = {};
    next.forEach((p) => {
      providerObj[p.name] = p.url;
    });
    try {
      await apiSearch.updateProviderConfig(providerObj);
      setProviders(next);
      void message.success('搜索源已保存');
      return true;
    } catch {
      void message.error('保存搜索源失败');
      return false;
    }
  }

  const categoryIdsValid = isValidNexusPhpCategoryIds(formCategoryId);

  const builtNexusPhpUrl =
    formBaseUrl.trim() && formPasskey.trim() && categoryIdsValid
      ? buildNexusPhpSearchUrl(formBaseUrl, formPasskey, formCategoryId)
      : '';

  // 预览里遮住 passkey（存储的 URL 不变）
  const previewNexusPhpUrl = builtNexusPhpUrl.replace(/(passkey=)([^&]+)/, (_, prefix: string, key: string) =>
    `${prefix}${key.length > 4 ? `${key.slice(0, 4)}…` : '…'}`,
  );

  const addFormUrl = formMode === 'nexusphp' ? builtNexusPhpUrl : formUrl.trim();
  const canAdd = !!formName.trim() && !!addFormUrl && validateUrl(addFormUrl);
  const canEdit = !!formName.trim() && !!formUrl.trim() && validateUrl(formUrl);

  function openAdd() {
    setEditingIndex(-1);
    setFormName('');
    setFormUrl('');
    setFormMode('custom');
    setFormBaseUrl('');
    setFormPasskey('');
    setFormCategoryId('');
    setDialogOpen(true);
  }

  function openEdit(index: number) {
    const provider = providers[index];
    if (!provider) return;
    setEditingIndex(index);
    setFormName(provider.name);
    setFormUrl(provider.url);
    setDialogOpen(true);
  }

  async function handleAdd() {
    if (!canAdd) return;
    const name = formName.trim();
    if (providers.some((p) => p.name === name)) {
      void message.error('同名搜索源已存在');
      return;
    }
    const next = [...providers, { name, url: addFormUrl }];
    if (await saveProviders(next)) setDialogOpen(false);
  }

  async function handleEdit() {
    if (!canEdit || editingIndex < 0) return;
    const name = formName.trim();
    if (providers.some((p, i) => p.name === name && i !== editingIndex)) {
      void message.error('同名搜索源已存在');
      return;
    }
    const next = providers.map((p, i) =>
      i === editingIndex ? { name, url: formUrl.trim() } : p,
    );
    if (await saveProviders(next)) setDialogOpen(false);
  }

  async function handleDelete(index: number) {
    const provider = providers[index];
    if (!provider || DEFAULT_PROVIDER_NAMES.includes(provider.name)) return;
    await saveProviders(providers.filter((_, i) => i !== index));
  }

  const editingIsDefault =
    editingIndex >= 0 && DEFAULT_PROVIDER_NAMES.includes(providers[editingIndex]?.name ?? '');

  return (
    <SectionCard title="搜索源设置">
      {loading ? (
        <Spin size="small" />
      ) : providers.length === 0 ? (
        <Typography.Text type="secondary">暂无搜索源</Typography.Text>
      ) : (
        providers.map((provider, index) => (
          <div
            key={provider.name}
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
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, fontSize: 14 }}>
                {provider.name}
                {DEFAULT_PROVIDER_NAMES.includes(provider.name) ? (
                  <Tag color="blue" style={{ marginLeft: 8 }}>
                    默认
                  </Tag>
                ) : null}
              </div>
              <Typography.Text
                type="secondary"
                title={provider.url}
                style={{
                  display: 'block',
                  fontSize: 12,
                  marginTop: 4,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily: 'monospace',
                }}
              >
                {provider.url}
              </Typography.Text>
            </div>
            <Space>
              <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(index)} />
              {!DEFAULT_PROVIDER_NAMES.includes(provider.name) ? (
                <Popconfirm
                  title="确定删除此搜索源？"
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  onConfirm={() => void handleDelete(index)}
                >
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              ) : null}
            </Space>
          </div>
        ))
      )}

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        URL 中使用 %s 作为搜索关键词的占位符
      </Typography.Text>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openAdd}>
          添加搜索源
        </Button>
      </div>

      <Modal
        open={dialogOpen}
        title={editingIndex >= 0 ? '编辑搜索源' : '添加搜索源'}
        onCancel={() => setDialogOpen(false)}
        footer={
          <>
            <Button onClick={() => setDialogOpen(false)}>取消</Button>
            <Button
              type="primary"
              disabled={editingIndex >= 0 ? !canEdit : !canAdd}
              onClick={() => void (editingIndex >= 0 ? handleEdit() : handleAdd())}
            >
              应用
            </Button>
          </>
        }
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {editingIndex < 0 ? (
            <Segmented
              value={formMode}
              onChange={(v) => setFormMode(v as AddMode)}
              options={[
                { label: '自定义 URL', value: 'custom' },
                { label: 'PT 站点（NexusPHP）', value: 'nexusphp' },
              ]}
            />
          ) : null}

          <div>
            <div style={{ marginBottom: 6 }}>名称</div>
            <Input
              maxLength={32}
              placeholder={
                editingIndex < 0 && formMode === 'nexusphp' ? '例如：audiences' : '例如：mikan'
              }
              value={formName}
              disabled={editingIsDefault}
              onChange={(e) => setFormName(e.target.value)}
            />
          </div>

          {editingIndex >= 0 || formMode === 'custom' ? (
            <div>
              <div style={{ marginBottom: 6 }}>URL 模板</div>
              <Input
                placeholder="https://example.com/search?q=%s"
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
                onPressEnter={() => void (editingIndex >= 0 ? handleEdit() : handleAdd())}
              />
              {formUrl && !validateUrl(formUrl) ? (
                <Alert
                  style={{ marginTop: 8 }}
                  type="error"
                  message="URL 必须包含 %s 作为搜索关键词占位符"
                />
              ) : null}
            </div>
          ) : (
            <>
              <div>
                <div style={{ marginBottom: 6 }}>站点地址</div>
                <Input
                  placeholder="https://audiences.me"
                  value={formBaseUrl}
                  onChange={(e) => setFormBaseUrl(e.target.value)}
                />
              </div>
              <div>
                <div style={{ marginBottom: 6 }}>Passkey</div>
                <Input
                  placeholder="站点用户控制面板中的 Passkey"
                  value={formPasskey}
                  onChange={(e) => setFormPasskey(e.target.value)}
                />
              </div>
              <div>
                <div style={{ marginBottom: 6 }}>分类 ID（可选）</div>
                <Input
                  placeholder="例如：402"
                  value={formCategoryId}
                  onChange={(e) => setFormCategoryId(e.target.value)}
                  onPressEnter={() => void handleAdd()}
                />
                {formCategoryId && !categoryIdsValid ? (
                  <Alert
                    style={{ marginTop: 8 }}
                    type="error"
                    message="分类 ID 必须是数字（多个用逗号分隔）"
                  />
                ) : null}
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: 1.5 }}>
                根据 Passkey 生成 torrentrss.php 搜索模板。注意：原生 NexusPHP 已停用 search
                参数、对任何搜索词都返回最新种子，请先在站点上确认 RSS 搜索确实按词过滤。
              </Typography.Text>
              {previewNexusPhpUrl ? (
                <Typography.Paragraph
                  type="secondary"
                  style={{
                    fontSize: 12,
                    fontFamily: 'monospace',
                    padding: '8px 12px',
                    background: token.colorFillTertiary,
                    borderRadius: 6,
                    wordBreak: 'break-all',
                    marginBottom: 0,
                  }}
                >
                  {previewNexusPhpUrl}
                </Typography.Paragraph>
              ) : null}
            </>
          )}
        </Space>
      </Modal>
    </SectionCard>
  );
}

/**
 * LLM 解析器设置（对应 Vue 版 config-llm）。
 * - provider 下拉由 apiLlm.listProviders 动态分组（内置/已安装预设/订阅账号/可下载）
 * - 内置提供商读写扁平字段；其它提供商读写 llm.providers[id] 覆盖
 * - 模型下拉可自由输入，打开下拉或点"拉取模型列表"时按需拉取
 * - 订阅类提供商走授权对话框连接/断开
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AutoComplete,
  Button,
  Collapse,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Typography,
  message,
  theme,
} from 'antd';
import type { LLMConfig } from '@ab/types';

import { apiConfig } from '@/api/config';
import { apiLlm, type ProviderView } from '@/api/llm';
import { useConfigGroup } from '@/stores/config';

import { LlmAuthDialog } from './llm-auth-dialog';
import { SectionCard } from './section-card';
import { SettingRow } from './setting-row';

// 已在 /config/llm/providers 中出现的都算"可用"；不在列表里的 = 可下载插件
const KNOWN_DOWNLOADABLE: { id: string; display_name: string }[] = [
  { id: 'github-copilot', display_name: 'GitHub Copilot' },
  { id: 'codex-chatgpt', display_name: 'ChatGPT (Codex)' },
];

// Copilot/Codex 属于 ToS 灰色区，安装前弹风险确认
function needsRiskNotice(id: string): boolean {
  return id === 'github-copilot' || id === 'codex-chatgpt';
}

type OverrideField = 'api_key' | 'model' | 'base_url';

export function ConfigLlm() {
  const [llm, setLlm] = useConfigGroup('llm');
  const { token } = theme.useToken();

  // --- 提供商列表 -----------------------------------------------------------
  const [providerList, setProviderList] = useState<ProviderView[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [busyProvider, setBusyProvider] = useState('');

  async function loadProviders() {
    try {
      setProviderList(await apiLlm.listProviders());
    } catch {
      setProviderList([]);
    } finally {
      setProvidersLoaded(true);
    }
  }

  useEffect(() => {
    void loadProviders();
  }, []);

  const selected = providerList.find((p) => p.id === llm.provider);
  const isSubscription =
    selected?.auth_kind === 'oauth' || selected?.auth_kind === 'device_code';
  // 可下载 = 列表已加载、未在列表中、且是已知可下载插件
  const isDownloadable =
    providersLoaded &&
    !selected &&
    KNOWN_DOWNLOADABLE.some((p) => p.id === llm.provider);
  // API-Key 表单：选中的是 api_key 类，或列表未加载/加载失败时的安全兜底
  const isBuiltinLike =
    selected?.auth_kind === 'api_key' || (!selected && !isDownloadable && !isSubscription);

  const providerOptions = useMemo(() => {
    const builtin = providerList.filter((p) => p.builtin);
    const installed = providerList.filter((p) => !p.builtin && p.auth_kind === 'api_key');
    const subscription = providerList.filter((p) => !p.builtin && p.auth_kind !== 'api_key');
    const installedIds = new Set(providerList.map((p) => p.id));
    const downloadable = KNOWN_DOWNLOADABLE.filter((p) => !installedIds.has(p.id));
    const groups: { label: string; options: { label: string; value: string }[] }[] = [];
    const toOpt = (p: { id: string; display_name: string }) => ({
      label: p.display_name,
      value: p.id,
    });
    if (builtin.length) groups.push({ label: '内置', options: builtin.map(toOpt) });
    if (installed.length) groups.push({ label: '已安装预设', options: installed.map(toOpt) });
    if (subscription.length) groups.push({ label: '订阅账号', options: subscription.map(toOpt) });
    if (downloadable.length) groups.push({ label: '可下载', options: downloadable.map(toOpt) });
    return groups;
  }, [providerList]);

  // --- 按提供商读写凭据/模型/端点：内置写扁平字段，其它写 providers[id] ------
  const isBuiltin = selected?.builtin ?? llm.provider === 'openai';

  function fieldGet(field: OverrideField): string {
    if (isBuiltin) return llm[field];
    return llm.providers?.[llm.provider]?.[field] ?? '';
  }

  function fieldSet(field: OverrideField, value: string) {
    if (isBuiltin) {
      setLlm({ ...llm, [field]: value });
      return;
    }
    const pid = llm.provider;
    const providers = { ...(llm.providers ?? {}) };
    const current = providers[pid] ?? { api_key: '', model: '', base_url: '' };
    providers[pid] = { ...current, [field]: value };
    setLlm({ ...llm, providers });
  }

  const apiKey = fieldGet('api_key');
  const model = fieldGet('model');
  const baseUrl = fieldGet('base_url');

  const modelPlaceholder = selected?.default_model || 'gpt-5-mini';
  const baseUrlPlaceholder = selected?.preset_base_url || 'https://api.openai.com/v1';

  // --- 安装 / 卸载 / 认证 -----------------------------------------------------
  const [showAuthDialog, setShowAuthDialog] = useState(false);
  const [confirmRisk, setConfirmRisk] = useState(false);

  async function onInstall(id: string) {
    if (needsRiskNotice(id) && !confirmRisk) {
      setConfirmRisk(true);
      return;
    }
    setConfirmRisk(false);
    setBusyProvider(id);
    try {
      await apiLlm.install(id);
      await loadProviders();
      void message.success('提供商已安装');
    } catch {
      // 失败详情由通知中心呈现
      void message.error('安装失败');
    } finally {
      setBusyProvider('');
    }
  }

  async function onUninstall(id: string) {
    setBusyProvider(id);
    try {
      await apiLlm.uninstall(id);
      await loadProviders();
    } catch {
      void message.error('安装失败');
    } finally {
      setBusyProvider('');
    }
  }

  async function onDisconnect(id: string) {
    try {
      await apiLlm.authDisconnect(id);
    } finally {
      await loadProviders();
    }
  }

  // --- 模型列表按需拉取（api_key 类）------------------------------------------
  const [modelOptions, setModelOptions] = useState<{ label: string; value: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const fetchedFor = useRef('');

  function credentialsKey(): string {
    return [llm.provider, apiKey, baseUrl].join('|');
  }

  async function fetchModels(force = false) {
    if (modelsLoading) return;
    if (!force && fetchedFor.current === credentialsKey()) return;
    setModelsLoading(true);
    try {
      const models = await apiConfig.listLlmModels(llm.provider, apiKey, baseUrl);
      setModelOptions(models.map((m) => ({ label: m, value: m })));
      fetchedFor.current = credentialsKey();
    } catch {
      void message.error('获取模型列表失败，请检查 API 密钥（及 API 地址）。');
    } finally {
      setModelsLoading(false);
    }
  }

  // 切换提供商后凭据变了，模型缓存作废
  const prevProvider = useRef(llm.provider);
  useEffect(() => {
    if (prevProvider.current !== llm.provider) {
      prevProvider.current = llm.provider;
      setModelOptions([]);
      fetchedFor.current = '';
      setConfirmRisk(false);
    }
  }, [llm.provider]);

  // --- 调优项（高级折叠区）----------------------------------------------------
  const tuningItems: { key: keyof LLMConfig; label: string }[] = [
    { key: 'timeout', label: '请求超时（秒）' },
    { key: 'cache_ttl', label: '解析缓存（秒）' },
    { key: 'max_concurrency', label: '最大并发数' },
    { key: 'failure_threshold', label: '熔断失败次数' },
    { key: 'failure_backoff', label: '熔断暂停时长（秒）' },
  ];

  return (
    <SectionCard title="LLM 解析器">
      <Alert
        type="info"
        showIcon
        message="openai 服务商兼容任意 OpenAI 格式端点（DeepSeek、Ollama、LM Studio、OpenRouter 等）；claude-haiku-4-5 与 gemini-2.5-flash 是较为经济的选择。"
      />

      <SettingRow label="启用 LLM 解析">
        <Switch checked={llm.enable} onChange={(v) => setLlm({ ...llm, enable: v })} />
      </SettingRow>

      {llm.enable ? (
        <>
          <SettingRow label="服务商">
            <Select
              style={{ width: 260, maxWidth: '100%' }}
              value={llm.provider}
              onChange={(v) => setLlm({ ...llm, provider: v })}
              options={providerOptions}
            />
          </SettingRow>

          <SettingRow label="解析模式">
            <Select
              style={{ width: 260, maxWidth: '100%' }}
              value={llm.mode}
              onChange={(v) => setLlm({ ...llm, mode: v })}
              options={[
                { label: '回退（正则优先）', value: 'fallback' },
                { label: '优先（LLM 优先）', value: 'primary' },
              ]}
            />
          </SettingRow>

          {/* 订阅类提供商：连接状态或 Connect 按钮 */}
          {isSubscription && selected ? (
            <div>
              {selected.connected ? (
                <Space>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: '#52c41a',
                      display: 'inline-block',
                    }}
                  />
                  <span style={{ fontSize: 13 }}>
                    已连接：{selected.account_label || selected.display_name}
                  </span>
                  <Button size="small" onClick={() => void onDisconnect(selected.id)}>
                    断开
                  </Button>
                </Space>
              ) : (
                <Button type="primary" size="small" onClick={() => setShowAuthDialog(true)}>
                  连接
                </Button>
              )}
            </div>
          ) : null}

          {/* api_key 类（内置 + 预设）：密钥 + 模型 + base_url */}
          {isBuiltinLike ? (
            <>
              <SettingRow label="API 密钥">
                <Input.Password
                  style={{ width: 320 }}
                  placeholder="sk-..."
                  value={apiKey}
                  onChange={(e) => fieldSet('api_key', e.target.value)}
                />
              </SettingRow>

              <SettingRow label="模型">
                <Space.Compact style={{ width: 420, maxWidth: '100%' }}>
                  <AutoComplete
                    style={{ flex: 1 }}
                    options={modelOptions}
                    value={model}
                    onChange={(v) => fieldSet('model', v)}
                    placeholder={modelPlaceholder}
                    onDropdownVisibleChange={(open) => {
                      if (open) void fetchModels();
                    }}
                  />
                  <Button loading={modelsLoading} onClick={() => void fetchModels(true)}>
                    拉取模型列表
                  </Button>
                </Space.Compact>
              </SettingRow>

              {selected?.needs_base_url ? (
                <SettingRow label="API 地址">
                  <Input
                    style={{ width: 320 }}
                    placeholder={baseUrlPlaceholder}
                    value={baseUrl}
                    onChange={(e) => fieldSet('base_url', e.target.value)}
                  />
                </SettingRow>
              ) : null}
            </>
          ) : null}

          {/* 可下载插件：安装按钮（灰色插件先弹风险确认） */}
          {isDownloadable ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                该提供商尚未安装。
              </Typography.Text>
              {!confirmRisk ? (
                <div>
                  <Button
                    type="primary"
                    size="small"
                    loading={busyProvider === llm.provider}
                    onClick={() => void onInstall(llm.provider)}
                  >
                    安装
                  </Button>
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    padding: '10px 12px',
                    borderRadius: 6,
                    border: `1px solid ${token.colorBorderSecondary}`,
                  }}
                >
                  <Typography.Text style={{ fontSize: 13 }}>
                    该提供商使用非官方订阅流程，第三方使用可能违反厂商条款、导致账号被限制。请自担风险后继续。
                  </Typography.Text>
                  <Space>
                    <Button size="small" onClick={() => setConfirmRisk(false)}>
                      取消
                    </Button>
                    <Button
                      danger
                      size="small"
                      loading={busyProvider === llm.provider}
                      onClick={() => void onInstall(llm.provider)}
                    >
                      仍然安装
                    </Button>
                  </Space>
                </div>
              )}
            </div>
          ) : null}

          {/* 已安装的非内置提供商：卸载入口 */}
          {selected && !selected.builtin && selected.plugin_version ? (
            <div>
              <Button
                danger
                size="small"
                loading={busyProvider === selected.id}
                onClick={() => void onUninstall(selected.id)}
              >
                卸载
              </Button>
            </div>
          ) : null}

          {/* 超时/缓存/并发/熔断调优项 */}
          <Collapse
            ghost
            items={[
              {
                key: 'tuning',
                label: '高级设置',
                children: (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {tuningItems.map((item) => (
                      <SettingRow key={item.key} label={item.label}>
                        <InputNumber
                          style={{ width: 180 }}
                          min={0}
                          value={llm[item.key] as number}
                          onChange={(v) => setLlm({ ...llm, [item.key]: v ?? 0 })}
                        />
                      </SettingRow>
                    ))}
                  </div>
                ),
              },
            ]}
          />
        </>
      ) : null}

      {selected ? (
        <LlmAuthDialog
          open={showAuthDialog}
          providerId={selected.id}
          displayName={selected.display_name}
          onClose={() => setShowAuthDialog(false)}
          onConnected={() => void loadProviders()}
        />
      ) : null}
    </SectionCard>
  );
}

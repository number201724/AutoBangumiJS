/**
 * 国产提供商 base_url 预设（纯数据，全部复用 OpenAIAdapter）。
 * 1:1 移植 module/parser/analyser/providers/presets.py。
 *
 * 这些提供商的订阅（Coding Plan 等）都是"发 API Key + OpenAI 兼容端点"，
 * 无需 OAuth；预设只是替用户省去手抄 base_url。大陆/海外端点分开列
 * （智谱 Coding Plan 的 Key 只在 coding 专用端点有效，与普通 v4 不互通）。
 *
 * 端点核实日期：2026-07（来源：各家官方文档 / Claude Code 接入指南）。
 */
import type { AdapterClass, ProviderInfo } from './base';
import { OpenAIAdapter } from './builtin';

export interface ProviderPreset {
  id: string;
  display_name: string;
  base_url: string;
  default_model: string;
  supports_json_schema: boolean;
}

export const PRESETS: ProviderPreset[] = [
  {
    id: 'zai',
    display_name: '智谱 GLM (Z.ai 海外)',
    base_url: 'https://api.z.ai/api/paas/v4',
    default_model: 'glm-4.7',
    supports_json_schema: true,
  },
  {
    id: 'zai-cn',
    display_name: '智谱 GLM (大陆 Coding Plan)',
    base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
    default_model: 'glm-4.7',
    supports_json_schema: true,
  },
  {
    id: 'minimax',
    display_name: 'MiniMax (海外)',
    base_url: 'https://api.minimax.io/v1',
    default_model: 'MiniMax-M2.5',
    supports_json_schema: false,
  },
  {
    id: 'minimax-cn',
    display_name: 'MiniMax (大陆)',
    base_url: 'https://api.minimaxi.com/v1',
    default_model: 'MiniMax-M2.5',
    supports_json_schema: false,
  },
  {
    id: 'deepseek',
    display_name: 'DeepSeek',
    base_url: 'https://api.deepseek.com',
    default_model: 'deepseek-v4-flash',
    supports_json_schema: false,
  },
  {
    id: 'kimi',
    display_name: 'Moonshot Kimi (海外)',
    base_url: 'https://api.moonshot.ai/v1',
    default_model: 'kimi-k2.5',
    supports_json_schema: true,
  },
  {
    id: 'kimi-cn',
    display_name: 'Moonshot Kimi (大陆)',
    base_url: 'https://api.moonshot.cn/v1',
    default_model: 'kimi-k2.5',
    supports_json_schema: true,
  },
];

function makeAdapter(preset: ProviderPreset): AdapterClass {
  const info: ProviderInfo = {
    id: preset.id,
    display_name: preset.display_name,
    auth_kind: 'api_key',
    builtin: false,
    needs_base_url: true,
    preset_base_url: preset.base_url,
    default_model: preset.default_model,
    supports_json_schema: preset.supports_json_schema,
    plugin_version: null,
  };
  return class extends OpenAIAdapter {
    static override readonly info: ProviderInfo = info;
  };
}

export const PRESET_ADAPTERS: Record<string, AdapterClass> = Object.fromEntries(
  PRESETS.map((preset) => [preset.id, makeAdapter(preset)]),
);

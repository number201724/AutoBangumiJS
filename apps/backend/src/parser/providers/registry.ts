/**
 * LLM 提供商注册表：内置适配器 + base_url 预设 + 已安装插件的统一入口。
 * 1:1 移植 module/parser/analyser/providers/registry.py。
 *
 * - ``listInfos()`` 只读静态描述（内置/预设直接读 info；插件读 manifest）；
 * - ``resolve()`` 返回适配器类；
 * - ``invalidate()`` 在安装/卸载/升级后丢弃插件缓存。
 *
 * 注意：插件层（module/llm_plugins 安装器）在本 TS 里程碑中只留接口和
 * 空实现——不扫描文件系统、不加载第三方代码。
 */
import { Logger } from '@nestjs/common';

import type { AdapterClass, ProviderInfo } from './base';
import { BUILTIN } from './builtin';
import { PRESET_ADAPTERS } from './presets';

const logger = new Logger('LLMRegistry');

/** Python ``ValueError(f"Unsupported LLM provider: {id}")`` 的对应物。 */
export class UnknownProviderError extends Error {
  constructor(providerId: string) {
    super(`Unsupported LLM provider: ${providerId}`);
    this.name = 'UnknownProviderError';
  }
}

/** 已安装插件的 manifest（插件层预留接口）。 */
export interface PluginManifest {
  id: string;
  name?: string;
  version?: string;
  auth_kind?: 'api_key' | 'oauth' | 'device_code';
  needs_base_url?: boolean;
  default_model?: string;
}

export class ProviderRegistry {
  private readonly pluginCache = new Map<string, AdapterClass>();

  /**
   * 扫描已安装插件目录，返回 {id: manifest}，不导入代码。
   * （空实现：TS 版不实现 module/llm_plugins 安装器。）
   */
  protected installedManifests(): Map<string, PluginManifest> {
    return new Map();
  }

  /** 列出全部可用提供商的静态描述（内置 → 预设 → 已安装插件）。 */
  listInfos(): ProviderInfo[] {
    const infos: ProviderInfo[] = [
      ...Object.values(BUILTIN).map((cls) => cls.info),
      ...Object.values(PRESET_ADAPTERS).map((cls) => cls.info),
    ];
    for (const [pluginId, manifest] of this.installedManifests()) {
      infos.push({
        id: pluginId,
        display_name: manifest.name ?? pluginId,
        auth_kind: manifest.auth_kind ?? 'api_key',
        builtin: false,
        needs_base_url: manifest.needs_base_url ?? false,
        preset_base_url: '',
        default_model: manifest.default_model ?? '',
        supports_json_schema: true,
        plugin_version: manifest.version ?? null,
      });
    }
    return infos;
  }

  /** 按 id 解析适配器类；未知 id 抛 UnknownProviderError。 */
  resolve(providerId: string): AdapterClass {
    const adapterClass =
      (BUILTIN as Record<string, AdapterClass>)[providerId] ?? PRESET_ADAPTERS[providerId];
    if (adapterClass !== undefined) {
      return adapterClass;
    }
    const cached = this.pluginCache.get(providerId);
    if (cached !== undefined) {
      return cached;
    }
    // 插件层空实现：installedManifests 恒为空，不会走到加载分支。
    if (this.installedManifests().has(providerId)) {
      logger.warn(`LLM plugin providers are not supported in this build: ${providerId}`);
    }
    throw new UnknownProviderError(providerId);
  }

  /** 插件安装/卸载后失效缓存。 */
  invalidate(providerId?: string): void {
    if (providerId === undefined) {
      this.pluginCache.clear();
    } else {
      this.pluginCache.delete(providerId);
    }
  }
}

export const registry = new ProviderRegistry();

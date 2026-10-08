/**
 * 设置中心（对应 Vue 版 pages/index/config.vue）。
 * 左侧锚点导航（含搜索过滤 + 脏值圆点）+ 分区卡片滚动容器 + 底部操作栏
 * （仅在有未保存修改时显示：保存全部 / 放弃更改）。
 */
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Button, Empty, Grid, Input, Modal, Spin, message, theme } from 'antd';
import type { Config } from '@ab/types';

import { apiProgram } from '@/api/program';
import { dirtyConfigGroups, useConfigStore, useDirtyGroups } from '@/stores/config';

import { ConfigAccess } from '@/components/setting/config-access';
import { ConfigDownload } from '@/components/setting/config-download';
import { ConfigLlm } from '@/components/setting/config-llm';
import { ConfigManage } from '@/components/setting/config-manage';
import { ConfigNetwork } from '@/components/setting/config-network';
import { ConfigNormal } from '@/components/setting/config-normal';
import { ConfigNotification } from '@/components/setting/config-notification';
import { ConfigParser } from '@/components/setting/config-parser';
import { ConfigPasskey } from '@/components/setting/config-passkey';
import { ConfigPlayer } from '@/components/setting/config-player';
import { ConfigProxy } from '@/components/setting/config-proxy';
import { ConfigSearchProvider } from '@/components/setting/config-search-provider';
import { ConfigSecurity } from '@/components/setting/config-security';
import { UpdateCard } from '@/components/setting/update-card';

interface ConfigSection {
  id: string;
  title: string;
  component: ComponentType;
  /** 参与全局保存/脏值比对的配置段；空数组 = 该卡片即时自存 */
  groups: Array<keyof Config>;
  keywords: string[];
}

const SECTIONS: ConfigSection[] = [
  {
    id: 'normal',
    title: '常规设置',
    component: ConfigNormal,
    groups: ['program', 'log'],
    keywords: ['program', 'rss', 'interval', 'port', 'debug', 'log', '端口', '调试'],
  },
  {
    id: 'parser',
    title: '解析设置',
    component: ConfigParser,
    groups: ['rss_parser'],
    keywords: [
      'parser',
      'engine',
      'classic',
      'preview',
      'tokenizer',
      'language',
      'filter',
      'exclude',
      '标题解析器',
      '经典解析器',
      '通用解析器',
    ],
  },
  {
    id: 'downloader',
    title: '下载设置',
    component: ConfigDownload,
    groups: ['downloader'],
    keywords: ['qbittorrent', 'aria2', 'mock', 'host', 'username', 'password', 'ssl', 'path'],
  },
  {
    id: 'manage',
    title: '番剧管理设置',
    component: ConfigManage,
    groups: ['bangumi_manage'],
    keywords: [
      'rename',
      'method',
      'eps',
      'group',
      'tag',
      'torrent',
      'revision',
      'conflict',
      'version',
      '修订',
      '冲突',
      '修订版冲突处理',
      '保留现有文件',
      '替换为更高修订版',
    ],
  },
  {
    id: 'notification',
    title: '通知设置',
    component: ConfigNotification,
    groups: ['notification'],
    keywords: [
      'telegram',
      'discord',
      'bark',
      'wecom',
      'gotify',
      'pushover',
      'webhook',
      'token',
      'server',
    ],
  },
  {
    id: 'proxy',
    title: '代理设置',
    component: ConfigProxy,
    groups: ['proxy'],
    keywords: ['proxy', 'http', 'socks5', 'host', 'port'],
  },
  {
    id: 'network',
    title: '网络设置',
    component: ConfigNetwork,
    groups: ['network'],
    keywords: ['network', 'tmdb', 'bangumi', 'bgm', 'mirror', 'api', 'key'],
  },
  {
    id: 'search-provider',
    title: '搜索源设置',
    component: ConfigSearchProvider,
    groups: [],
    keywords: ['search', 'provider', 'mikan', 'url', 'nexusphp'],
  },
  {
    id: 'player',
    title: '播放器设置',
    component: ConfigPlayer,
    groups: [],
    keywords: ['player', 'plex', 'jellyfin', 'emby', 'url', 'iframe', 'jump'],
  },
  {
    id: 'llm',
    title: 'LLM 解析器',
    component: ConfigLlm,
    groups: ['llm'],
    keywords: ['llm', 'openai', 'anthropic', 'gemini', 'api', 'model'],
  },
  {
    id: 'passkey',
    title: 'Passkey 设置',
    component: ConfigPasskey,
    groups: [],
    keywords: ['passkey', 'webauthn', 'login', '通行密钥'],
  },
  {
    id: 'access',
    title: '用户与访问控制',
    component: ConfigAccess,
    groups: [],
    keywords: ['user', 'account', 'token', 'api', 'mcp', 'access', '用户', '令牌'],
  },
  {
    id: 'security',
    title: '安全设置',
    component: ConfigSecurity,
    groups: ['security'],
    keywords: ['security', 'whitelist', 'ip', 'token', 'mcp', '白名单'],
  },
  {
    id: 'update',
    title: '软件更新',
    // channel/auto_check 在无脏值时即时写回；有脏值时改内存随全局保存提交
    component: UpdateCard,
    groups: ['update'],
    keywords: ['update', 'version', 'upgrade', 'release', 'rollback', '更新', '回滚'],
  },
];

function sectionMatches(section: ConfigSection, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;
  return [section.title, ...section.keywords, ...section.groups].some((text) =>
    text.toLowerCase().includes(query),
  );
}

function DirtyDot() {
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: '#fa8c16',
        flexShrink: 0,
        display: 'inline-block',
      }}
    />
  );
}

export function ConfigPage() {
  const screens = Grid.useBreakpoint();
  const isDesktop = screens.lg ?? false;
  const { token } = theme.useToken();

  const draft = useConfigStore((s) => s.draft);
  const dirtyGroups = useDirtyGroups();
  const isDirty = dirtyGroups.length > 0;

  // --- 搜索 ---
  const [searchQuery, setSearchQuery] = useState('');
  const visibleSections = useMemo(
    () => SECTIONS.filter((s) => sectionMatches(s, searchQuery)),
    [searchQuery],
  );

  function sectionDirty(section: ConfigSection): boolean {
    return section.groups.some((g) => dirtyGroups.includes(g));
  }

  const dirtySectionTitles = SECTIONS.filter(sectionDirty).map((s) => s.title);

  // --- 分区定位（滚动侦测） ---
  const scrollEl = useRef<HTMLDivElement | null>(null);
  const sectionEls = useRef(new Map<string, HTMLElement>());
  const [activeSection, setActiveSection] = useState(SECTIONS[0]?.id ?? '');

  function setSectionEl(id: string, el: HTMLElement | null) {
    if (el) sectionEls.current.set(id, el);
    else sectionEls.current.delete(id);
  }

  function onScroll() {
    const container = scrollEl.current;
    if (!container) return;
    const anchor = container.scrollTop + 80;
    let current = visibleSections[0]?.id ?? SECTIONS[0]?.id ?? '';
    for (const section of visibleSections) {
      const el = sectionEls.current.get(section.id);
      if (el && el.offsetTop <= anchor) current = section.id;
    }
    setActiveSection(current);
  }

  function jumpTo(id: string) {
    const el = sectionEls.current.get(id);
    if (!el) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    setActiveSection(id);
  }

  // --- 加载：有未保存修改时不重新拉取，避免静默覆盖用户输入 ---
  useEffect(() => {
    const state = useConfigStore.getState();
    if (dirtyConfigGroups(state.saved, state.draft).length === 0) {
      void state.load().catch(() => undefined);
    }
  }, []);

  // 页面关闭/刷新时拦截（应用内路由守卫需要 data router，见报告说明）
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // --- 保存 / 放弃 ---
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  function onSaveClick() {
    Modal.confirm({
      title: '保存全部修改',
      content: '确定保存全部修改？部分设置需要重启才能生效。',
      okText: '保存',
      cancelText: '取消',
      onOk: async () => {
        setIsSaving(true);
        try {
          await useConfigStore.getState().save();
          setSaveFailed(false);
          void message.success('已保存，部分设置需要重启生效');
          Modal.confirm({
            title: '重启生效',
            content: '是否立即重启 AutoBangumi 以应用新设置？',
            okText: '立即重启',
            cancelText: '稍后',
            onOk: async () => {
              try {
                await apiProgram.restart();
                void message.success('重启指令已发送');
              } catch {
                /* 拦截器已提示 */
              }
            },
          });
        } catch {
          setSaveFailed(true);
        } finally {
          setIsSaving(false);
        }
      },
    });
  }

  function onDiscardClick() {
    Modal.confirm({
      title: '放弃修改',
      content: '放弃未保存的修改？',
      okText: '放弃修改',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setIsResetting(true);
        try {
          await useConfigStore.getState().discard();
          setSaveFailed(false);
        } catch {
          /* 拦截器已提示 */
        } finally {
          setIsResetting(false);
        }
      },
    });
  }

  if (!draft) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 80 }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div
      style={{
        height: 'calc(100vh - 112px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', gap: 16 }}>
        {isDesktop ? (
          <nav
            aria-label="搜索设置"
            style={{
              width: 190,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              overflowY: 'auto',
              paddingRight: 2,
            }}
          >
            <Input
              allowClear
              type="search"
              placeholder="搜索设置…"
              aria-label="搜索设置"
              style={{ marginBottom: 8, width: '100%' }}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {visibleSections.map((s) => {
              const active = activeSection === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  onClick={() => jumpTo(s.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    padding: '6px 10px',
                    border: 'none',
                    borderRadius: 6,
                    background: active ? token.colorPrimaryBg : 'transparent',
                    color: active ? token.colorPrimary : token.colorTextSecondary,
                    fontWeight: active ? 600 : 400,
                    fontSize: 13,
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {s.title}
                  </span>
                  {sectionDirty(s) ? <DirtyDot /> : null}
                </button>
              );
            })}
          </nav>
        ) : null}

        <div
          ref={scrollEl}
          onScroll={onScroll}
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            maxWidth: 860,
            overflowY: 'auto',
            overflowX: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            scrollPaddingTop: 4,
            paddingRight: 4,
          }}
        >
          {visibleSections.length === 0 ? (
            <Empty description="没有匹配搜索的设置">
              <Button size="small" onClick={() => setSearchQuery('')}>
                清除筛选
              </Button>
            </Empty>
          ) : (
            visibleSections.map((s) => {
              const SectionComponent = s.component;
              return (
                <div
                  key={s.id}
                  ref={(el) => setSectionEl(s.id, el)}
                  style={{ scrollMarginTop: 4 }}
                >
                  <SectionComponent />
                </div>
              );
            })
          )}
        </div>
      </div>

      {isDirty ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            padding: '10px 12px',
            borderRadius: 8,
            border: `1px solid ${token.colorBorderSecondary}`,
            background: token.colorBgContainer,
          }}
        >
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              minWidth: 0,
              marginRight: 'auto',
              fontSize: 13,
              color: token.colorTextSecondary,
            }}
            role="status"
          >
            <DirtyDot />
            <b style={{ color: token.colorText, whiteSpace: 'nowrap' }}>
              {dirtyGroups.length} 处未保存修改
            </b>
            {isDesktop && dirtySectionTitles.length > 0 ? (
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                · {dirtySectionTitles.join(', ')}
              </span>
            ) : null}
          </span>

          <Button
            loading={isResetting}
            disabled={isResetting || isSaving}
            onClick={onDiscardClick}
          >
            放弃更改
          </Button>
          <Button
            type="primary"
            danger={saveFailed}
            loading={isSaving}
            disabled={isResetting || isSaving}
            onClick={onSaveClick}
          >
            保存全部
          </Button>
        </div>
      ) : null}
    </div>
  );
}

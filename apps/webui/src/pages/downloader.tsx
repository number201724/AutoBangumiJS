/**
 * 下载器 — React/AntD port of pages/index/downloader.vue + useTorrentList.ts。
 * 种子按 save_path 分组展示，支持批量暂停/恢复/删除、手动/自动打标、
 * 重命名冲突处理与搜索番剧订阅。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Collapse,
  Empty,
  InputNumber,
  Modal,
  Progress,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  theme,
  message,
} from 'antd';
import type { TableProps } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
  TagOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router-dom';

import { apiConfig } from '@/api/config';
import { apiDownloader, type TorrentInfo } from '@/api/downloader';
import { apiProgram } from '@/api/program';
import { useDownloaderStore } from '@/stores/downloader';
import { RenameConflictsPanel } from '@/components/downloader/rename-conflicts-panel';
import { SearchBangumiModal } from '@/components/downloader/search-bangumi-modal';

interface TorrentGroup {
  name: string;
  savePath: string;
  count: number;
  torrents: TorrentInfo[];
}

/** 仅含季度的目录名（Season 1 / S01 / 第1季 …），组名需带上父目录。 */
const SEASON_ONLY_RE = /^(Season\s*\d+|S\d+|第\d+季)$/i;

/** 种子按保存路径分组 — mirrors store/downloader.ts 的 groups computed。 */
function groupTorrents(torrents: TorrentInfo[]): TorrentGroup[] {
  const map = new Map<string, TorrentInfo[]>();
  for (const t of torrents) {
    const key = t.save_path;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(t);
  }

  const groups: TorrentGroup[] = [];
  for (const [savePath, items] of map) {
    const parts = savePath.replace(/\/$/, '').split('/').filter(Boolean);
    let name = parts[parts.length - 1] || savePath;
    if (parts.length >= 2 && SEASON_ONLY_RE.test(name)) {
      name = `${parts[parts.length - 2]} / ${name}`;
    }
    groups.push({
      name,
      savePath,
      count: items.length,
      torrents: items.sort((a, b) => (b.added_on ?? 0) - (a.added_on ?? 0)),
    });
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name));
}

function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

function stateLabel(state: string): string {
  const map: Record<string, string> = {
    downloading: '下载中',
    uploading: '做种中',
    pausedDL: '已暂停',
    pausedUP: '已暂停',
    // qBittorrent 5.0+ 把 paused* 状态改名为 stopped*
    stoppedDL: '已暂停',
    stoppedUP: '已暂停',
    stalledDL: '等待中',
    stalledUP: '做种中',
    queuedDL: '排队中',
    queuedUP: '排队中',
    checkingDL: '校验中',
    checkingUP: '校验中',
    error: '错误',
    missingFiles: '错误',
    metaDL: '获取元数据',
  };
  return map[state] || state || '—';
}

function stateColor(state: string): string {
  if (state.includes('paused') || state.includes('stopped')) return 'default';
  if (state === 'downloading' || state === 'forcedDL') return 'success';
  if (state.includes('UP') || state === 'uploading') return 'processing';
  if (state === 'error' || state === 'missingFiles') return 'error';
  return 'processing';
}

interface AutoTagResult {
  status: boolean;
  tagged_count: number;
  unmatched_count: number;
  unmatched: Array<{ hash: string; name: string; save_path: string }>;
  msg_en: string;
  msg_zh: string;
}

export function DownloaderPage() {
  const { token } = theme.useToken();
  const {
    torrents,
    selectedHashes,
    loading,
    getAll,
    setSelectedHashes,
    clearSelection,
    pauseSelected,
    resumeSelected,
    deleteSelected,
  } = useDownloaderStore();

  const [hostEmpty, setHostEmpty] = useState(false);
  const [downloaderOk, setDownloaderOk] = useState<boolean | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [conflictCount, setConflictCount] = useState(0);

  const [tagOpen, setTagOpen] = useState(false);
  const [bangumiId, setBangumiId] = useState<number | null>(null);
  const [tagging, setTagging] = useState(false);

  const [autoTagging, setAutoTagging] = useState(false);
  const [autoTagResult, setAutoTagResult] = useState<AutoTagResult | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const groups = useMemo(() => groupTorrents(torrents), [torrents]);
  // 组集合变化时重挂 Collapse，让新出现的组默认展开（组内种子刷新不重挂）
  const groupKeySet = groups.map((g) => g.savePath).join('\n');

  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;

    void (async () => {
      try {
        const cfg = await apiConfig.get();
        if (cfg.downloader.host === '') {
          setHostEmpty(true);
          return;
        }
      } catch {
        /* 配置拉取失败时继续尝试加载种子列表 */
      }
      apiProgram
        .checkDownloader()
        .then(setDownloaderOk)
        .catch(() => setDownloaderOk(false));
      void getAll();
      apiDownloader
        .getRenameConflicts()
        .then((list) => setConflictCount(list.length))
        .catch(() => {
          /* 角标失败不影响主流程 */
        });
    })();

    // 5s 轮询；页面不可见时跳过
    const timer = setInterval(() => {
      if (!document.hidden && activeRef.current) void getAll();
    }, 5000);

    return () => {
      activeRef.current = false;
      clearInterval(timer);
      clearSelection();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function groupCheckedKeys(group: TorrentGroup): string[] {
    return group.torrents.filter((t) => selectedHashes.includes(t.hash)).map((t) => t.hash);
  }

  function onGroupCheckedChange(group: TorrentGroup, keys: string[]) {
    const groupHashes = group.torrents.map((t) => t.hash);
    const others = selectedHashes.filter((h) => !groupHashes.includes(h));
    setSelectedHashes([...others, ...keys]);
  }

  async function onDelete() {
    setDeleting(true);
    try {
      await deleteSelected(deleteFiles);
      setDeleteOpen(false);
      setDeleteFiles(false);
    } finally {
      setDeleting(false);
    }
  }

  async function onApplyTag() {
    if (!bangumiId || selectedHashes.length === 0) return;
    setTagging(true);
    try {
      const results = await Promise.allSettled(
        selectedHashes.map((h) => apiDownloader.tag(h, bangumiId)),
      );
      const okCount = results.filter(
        (r) => r.status === 'fulfilled' && (r.value as { status?: boolean })?.status !== false,
      ).length;
      if (okCount === selectedHashes.length) {
        void message.success(`已为 ${okCount} 个种子添加标签 ab:${bangumiId}`);
      } else {
        void message.warning(`已标记 ${okCount}/${selectedHashes.length} 个种子，其余失败`);
      }
      setTagOpen(false);
      setBangumiId(null);
      clearSelection();
      void getAll();
    } finally {
      setTagging(false);
    }
  }

  async function onAutoTag() {
    setAutoTagging(true);
    try {
      const res = await apiDownloader.autoTag();
      setAutoTagResult(res);
      void getAll();
    } finally {
      setAutoTagging(false);
    }
  }

  const columns: ColumnsType<TorrentInfo> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
      render: (name: string) => (
        <Tooltip title={name}>
          <Typography.Text>{name}</Typography.Text>
        </Tooltip>
      ),
    },
    {
      title: '进度',
      key: 'progress',
      width: 150,
      render: (_, row) => {
        const percent = Math.round((row.progress ?? 0) * 100);
        const failed = row.state === 'error' || row.state === 'missingFiles';
        return (
          <Progress percent={percent} size="small" status={failed ? 'exception' : 'active'} />
        );
      },
    },
    {
      title: '状态',
      key: 'state',
      width: 100,
      render: (_, row) => <Tag color={stateColor(row.state ?? '')}>{stateLabel(row.state ?? '')}</Tag>,
    },
    {
      title: '大小',
      key: 'size',
      width: 90,
      render: (_, row) => formatSize(row.size ?? 0),
    },
    {
      title: '保存路径',
      dataIndex: 'save_path',
      key: 'save_path',
      ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v}>
          <Typography.Text type="secondary">{v}</Typography.Text>
        </Tooltip>
      ),
    },
    {
      title: '标签',
      dataIndex: 'tags',
      key: 'tags',
      width: 160,
      render: (v: string | undefined) => {
        const tags = (v ?? '').split(',').filter(Boolean);
        if (tags.length === 0) return '—';
        return (
          <Space size={4} wrap>
            {tags.map((t) => (
              <Tag key={t}>{t}</Tag>
            ))}
          </Space>
        );
      },
    },
  ];

  if (hostEmpty) {
    return (
      <Card>
        <Empty
          description={
            <>
              <Typography.Title level={4}>下载器未配置</Typography.Title>
              <Typography.Text type="secondary">
                连接下载客户端以在此管理种子
              </Typography.Text>
              <div style={{ marginTop: 16, textAlign: 'left', maxWidth: 420, margin: '16px auto 0' }}>
                <p>1. 打开设置 — 前往设置页面，找到下载器设置部分。</p>
                <p>2. 输入连接信息 — 设置 qBittorrent 的地址、用户名和密码。</p>
                <p>3. 访问下载器 — 配置完成后即可在此管理种子。</p>
              </div>
            </>
          }
        >
          <Link to="/config">
            <Button type="primary" icon={<SettingOutlined />}>
              设置
            </Button>
          </Link>
        </Empty>
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 60 }}>
      {downloaderOk === false && (
        <Alert
          type="error"
          showIcon
          message="下载器连接不可用"
          description="无法连接下载客户端，请前往「设置」检查下载器地址、用户名和密码。"
        />
      )}

      <Card size="small">
        <Space wrap>
          <Button icon={<SearchOutlined />} onClick={() => setSearchOpen(true)}>
            搜索番剧
          </Button>
          <Button
            icon={<TagOutlined />}
            disabled={selectedHashes.length === 0}
            onClick={() => setTagOpen(true)}
          >
            标记番剧
          </Button>
          <Button
            icon={<ThunderboltOutlined />}
            loading={autoTagging}
            onClick={() => void onAutoTag()}
          >
            自动标记
          </Button>
          <Badge count={conflictCount} size="small" offset={[-4, 4]}>
            <Button icon={<WarningOutlined />} onClick={() => setConflictsOpen(true)}>
              重命名冲突
            </Button>
          </Badge>
          <Button icon={<ReloadOutlined />} onClick={() => void getAll()}>
            刷新
          </Button>
        </Space>
      </Card>

      {groups.length === 0 && !loading ? (
        <Card>
          <Empty description="Bangumi 分类中暂无种子" />
        </Card>
      ) : (
        <Collapse
          key={groupKeySet}
          defaultActiveKey={groups.map((g) => g.savePath)}
          items={groups.map((group) => ({
            key: group.savePath,
            label: `${group.name} (${group.count})`,
            children: (
              <Table<TorrentInfo>
                columns={columns}
                dataSource={group.torrents}
                rowKey="hash"
                size="small"
                pagination={false}
                scroll={{ x: 860 }}
                rowSelection={
                  {
                    selectedRowKeys: groupCheckedKeys(group),
                    onChange: (keys) => onGroupCheckedChange(group, keys as string[]),
                  } satisfies TableProps<TorrentInfo>['rowSelection']
                }
              />
            ),
          }))}
        />
      )}

      {selectedHashes.length > 0 && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '10px 20px',
            borderRadius: token.borderRadiusLG,
            background: token.colorBgElevated,
            border: `1px solid ${token.colorBorder}`,
            boxShadow: token.boxShadowSecondary,
            maxWidth: 'calc(100vw - 32px)',
          }}
        >
          <Typography.Text type="secondary" style={{ whiteSpace: 'nowrap' }}>
            {selectedHashes.length} 已选择
          </Typography.Text>
          <Space size={8}>
            <Button type="primary" size="small" onClick={() => void resumeSelected()}>
              恢复
            </Button>
            <Button size="small" onClick={() => void pauseSelected()}>
              暂停
            </Button>
            <Button size="small" danger onClick={() => setDeleteOpen(true)}>
              删除
            </Button>
          </Space>
        </div>
      )}

      {/* 删除确认（可选同时删除文件） */}
      <Modal
        open={deleteOpen}
        title="删除"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        confirmLoading={deleting}
        onCancel={() => setDeleteOpen(false)}
        onOk={() => void onDelete()}
      >
        <p>从下载器中移除所选种子？已下载的文件将保留。</p>
        <Checkbox
          checked={deleteFiles}
          onChange={(e) => setDeleteFiles(e.target.checked)}
        >
          同时删除已下载的文件
        </Checkbox>
      </Modal>

      {/* 手动标记番剧 */}
      <Modal
        open={tagOpen}
        title="标记番剧"
        okText="标记"
        cancelText="取消"
        confirmLoading={tagging}
        onCancel={() => setTagOpen(false)}
        onOk={() => void onApplyTag()}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text>
            为选中的 {selectedHashes.length} 个种子添加番剧标签（ab:ID）。
          </Typography.Text>
          <InputNumber
            min={1}
            style={{ width: '100%' }}
            placeholder="番剧 ID"
            value={bangumiId}
            onChange={(v) => setBangumiId(v)}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            番剧 ID 可在「番剧管理」页面查看；标签用于准确的集数偏移匹配。
          </Typography.Text>
        </Space>
      </Modal>

      {/* 自动标记结果 */}
      <Modal
        open={autoTagResult !== null}
        title="自动标记结果"
        footer={
          <Button type="primary" onClick={() => setAutoTagResult(null)}>
            确定
          </Button>
        }
        onCancel={() => setAutoTagResult(null)}
      >
        {autoTagResult && (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Typography.Text>
              {autoTagResult.msg_zh ||
                `已标记 ${autoTagResult.tagged_count} 个种子，${autoTagResult.unmatched_count} 个无法匹配`}
            </Typography.Text>
            {autoTagResult.unmatched.length > 0 && (
              <>
                <Typography.Text type="secondary">未匹配（最多显示 10 条）：</Typography.Text>
                <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                  {autoTagResult.unmatched.map((u) => (
                    <li key={u.hash}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {u.name}
                      </Typography.Text>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Space>
        )}
      </Modal>

      <RenameConflictsPanel
        open={conflictsOpen}
        onClose={() => setConflictsOpen(false)}
        onCountChange={setConflictCount}
      />
      <SearchBangumiModal open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

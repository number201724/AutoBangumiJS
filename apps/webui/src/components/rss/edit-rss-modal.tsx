/** 编辑 RSS（名称 / 解析器）对话框。 */
import { useEffect, useState } from 'react';
import { Input, Modal, Select, Space, Typography } from 'antd';

import { useRssStore } from '@/stores/rss';
import type { RSS } from '@ab/types';

const PARSER_TYPES = ['tmdb', 'mikan', 'parser', 'ani'];

interface Props {
  /** 正在编辑的 RSS；null 表示关闭。 */
  rss: RSS | null;
  onClose: () => void;
}

export function EditRssModal({ rss, onClose }: Props) {
  const update = useRssStore((s) => s.update);
  const [name, setName] = useState('');
  const [parser, setParser] = useState<string>('tmdb');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (rss) {
      setName(rss.name ?? '');
      setParser(rss.parser || 'tmdb');
    }
  }, [rss]);

  async function onSave() {
    if (!rss) return;
    setSaving(true);
    try {
      const ok = await update(rss.id, { name: name.trim() || null, parser });
      if (ok) onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={rss !== null}
      title="编辑 RSS"
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      onCancel={onClose}
      onOk={() => void onSave()}
      destroyOnClose
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <div>
          <Typography.Text strong>名称</Typography.Text>
          <Input
            style={{ marginTop: 8 }}
            placeholder="可选"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <Typography.Text strong>解析器</Typography.Text>
          <Select
            style={{ width: '100%', marginTop: 8 }}
            value={parser}
            options={PARSER_TYPES.map((p) => ({ value: p, label: p }))}
            onChange={setParser}
          />
        </div>
      </Space>
    </Modal>
  );
}

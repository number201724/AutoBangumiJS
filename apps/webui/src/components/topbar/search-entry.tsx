/**
 * Search entry in the top bar — mirrors ab-search-bar: a search-styled
 * trigger that opens the global search modal (components/search).
 */
import { Input, Spin } from 'antd';
import { SearchOutlined } from '@ant-design/icons';

import { useSearchStore } from '@/stores/search';
import { SearchModal } from '@/components/search';

export function SearchEntry() {
  const showModal = useSearchStore((s) => s.showModal);
  const loading = useSearchStore((s) => s.loading);
  const toggleModal = useSearchStore((s) => s.toggleModal);

  return (
    <>
      <div style={{ width: 280, maxWidth: '40vw' }}>
        <Input
          readOnly
          prefix={<SearchOutlined />}
          placeholder="搜索番剧…"
          onClick={toggleModal}
          style={{ cursor: 'pointer' }}
          suffix={loading ? <Spin size="small" /> : null}
        />
      </div>
      {showModal && <SearchModal />}
    </>
  );
}

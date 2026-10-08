/**
 * Online updater — deferred to phase 2 (per project plan). checkUpdate is the
 * only piece the periodic loop touches; it reports "unavailable" so the loop
 * silently skips, matching the Python "check failed" branch.
 */
export interface UpdateCheckResult {
  error: string | null;
  has_update: boolean;
  current: string;
  latest: string | null;
  channel: string;
  notes: string | null;
}

export async function checkUpdate(channel: string, force: boolean): Promise<UpdateCheckResult> {
  void channel;
  void force;
  return {
    error: 'online update module is not available in this build',
    has_update: false,
    current: '',
    latest: null,
    channel: 'stable',
    notes: null,
  };
}

export interface UpdateProgress {
  phase: string;
  [key: string]: unknown;
}

/** SSE 更新进度帧（二期实现在线更新后返回真实进度）。 */
export function getUpdateProgress(): UpdateProgress {
  return { phase: 'idle' };
}

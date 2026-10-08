/**
 * Runtime holder — mirrors `app.state.ctx` (module/api/deps.py get_context).
 */
import type { AppContext } from './context';

export const runtime: { ctx: AppContext | null } = { ctx: null };

export function getContext(): AppContext {
  if (!runtime.ctx) {
    throw new Error('AppContext not initialized');
  }
  return runtime.ctx;
}

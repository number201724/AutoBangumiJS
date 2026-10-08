/** Program control endpoints — mirrors webui/src/api/program.ts + check.ts. */
import { api } from './client';

export interface ProgramStatus {
  status: boolean;
  version: string;
  first_run: boolean;
}

export const apiProgram = {
  async start() {
    const { data } = await api.post('api/v1/start');
    return data;
  },
  async stop() {
    const { data } = await api.post('api/v1/stop');
    return data;
  },
  async restart() {
    const { data } = await api.post('api/v1/restart');
    return data;
  },
  async shutdown() {
    const { data } = await api.post('api/v1/shutdown');
    return data;
  },
  async status() {
    const { data } = await api.get<ProgramStatus>('api/v1/status', { silent: true });
    return data;
  },
  async checkDownloader() {
    const { data } = await api.get<boolean>('api/v1/check/downloader', { silent: true });
    return data;
  },
};

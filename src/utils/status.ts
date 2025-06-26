import type { ServerStatus } from '../types';

// Generate current statuses from sheet rows
export const generateCurrentStatuses = async (
  rows: string[][]
): Promise<{
  currentStatuses: Record<string, ServerStatus>;
  removedStatuses: Record<string, boolean>;
}> => {
  const currentStatuses: Record<string, ServerStatus> = {};
  const removedStatuses: Record<string, boolean> = {};
  for (let i = 0; i < rows.length; i++) {
    const [serverName, serverUrl, status, lastUpdate] = rows[i];
    if (serverName || serverUrl) {
      const key = serverName || serverUrl;
      currentStatuses[key] = { status, lastUpdate } as ServerStatus;
    }
  }
  return { currentStatuses, removedStatuses };
};

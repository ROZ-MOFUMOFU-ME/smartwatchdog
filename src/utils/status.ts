import type { ServerStatus } from '../types';
import { getCurrentTimestamp } from './date';

// A list of ports that should be checked with HTTP(S) fetch. Others will use TCP connect.
const HTTP_PORTS = [80, 443, 8080, 8443];

type Socket = {
  opened: Promise<unknown>;
  close: () => Promise<void>;
};
type ConnectFn = (options: { hostname: string; port: number }) => Socket;
let connect: ConnectFn | undefined;
const getConnect = async (): Promise<ConnectFn> => {
  if (connect) return connect;
  try {
    connect = (await import('cloudflare:sockets')).connect as ConnectFn;
  } catch {
    connect = () => ({
      opened: Promise.resolve(),
      close: async () => {},
    });
  }
  return connect;
};

// テスト用: 強制的にcatchブロックに入れるフラグ
let __test_forceError = false;
const __setTestForceError = (v: boolean) => {
  __test_forceError = v;
};

// Check server status with a TCP connection, including a timeout.
const checkTcpStatus = async (
  hostname: string,
  port: number
): Promise<string> => {
  const timeoutPromise = new Promise<string>(
    (resolve) => setTimeout(() => resolve('ERROR: TCP Timeout'), 15000) // 15-second timeout
  );

  const connectPromise = (async () => {
    let socket;
    try {
      if (__test_forceError) throw new Error('test-force-error');
      const connectFn = await getConnect();
      socket = connectFn({ hostname, port });
      try {
        await socket.opened;
        return 'OK: Status 200';
      } catch {
        return 'ERROR: TCP Port Unreachable';
      } finally {
        await socket?.close().catch(() => {});
      }
    } catch {
      return `ERROR: TCP Port Unreachable`;
    }
  })();

  return Promise.race([connectPromise, timeoutPromise]);
};

// Check server status by determining the correct method (HTTP fetch or TCP connect)
const checkServerStatus = async (url: string): Promise<string> => {
  if (!url) {
    return 'INVALID_URL';
  }

  let parsedUrl: URL;
  try {
    // Ensure we can parse it, even if it's just `host:port`
    parsedUrl = new URL(url.includes('://') ? url : `tcp://${url}`);
  } catch {
    return 'INVALID_URL_FORMAT';
  }

  const { hostname, port: portStr, protocol } = parsedUrl;
  const port = portStr
    ? parseInt(portStr, 10)
    : protocol === 'https:'
      ? 443
      : 80;

  // Use HTTP check for standard web ports or if protocol is explicitly https
  if (
    protocol === 'https:' ||
    (protocol === 'http:' && HTTP_PORTS.includes(port))
  ) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(10000), // 10-second timeout
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        },
      });
      // We don't need the body, so we should close it.
      if (response.body) {
        response.body.cancel();
      }
      if (response.status === 200) {
        return 'OK: Status 200';
      }
      return `ERROR: Status ${response.status}`;
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error &&
        'name' in error &&
        (error as { name?: unknown }).name === 'TimeoutError'
      ) {
        return 'ERROR: HTTP Timeout';
      }
      return `ERROR: Unreachable`;
    }
  }

  // For all others, perform a raw TCP socket connection test
  return checkTcpStatus(hostname, port);
};

// Generate current statuses from sheet rows by actively checking them
export const generateCurrentStatuses = async (
  rows: string[][]
): Promise<{
  currentStatuses: Record<string, ServerStatus>;
  removedStatuses: Record<string, boolean>;
}> => {
  const currentStatuses: Record<string, ServerStatus> = {};
  const removedStatuses: Record<string, boolean> = {};
  const lastUpdate = getCurrentTimestamp();

  const statusPromises = rows.map(async (row) => {
    const [serverName, serverUrl] = row;
    const key = serverName || serverUrl;

    // Server NameがあるがServer URLが空の場合は何もしない
    if (serverName && !serverUrl) {
      return;
    }
    if (key) {
      const status = await checkServerStatus(serverUrl);
      currentStatuses[key] = { status, lastUpdate };
    }
  });

  await Promise.all(statusPromises);

  return { currentStatuses, removedStatuses };
};

export { checkTcpStatus, __setTestForceError };

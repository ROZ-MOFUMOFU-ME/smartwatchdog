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

const TCP_TIMEOUT_MS = 15000;

// チェックが失敗した理由をログに残す（誤検知の原因を後から Workers Logs で追えるように）
const logCheckFailure = (target: string, reason: unknown): void => {
  const detail =
    reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : String(reason);
  console.warn(`[check failed] ${target}: ${detail}`);
};

// Check server status with a TCP connection, including a timeout.
const checkTcpStatus = async (
  hostname: string,
  port: number
): Promise<string> => {
  const target = `${hostname}:${port}`;
  let socket: Socket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve('ERROR: TCP Timeout');
    }, TCP_TIMEOUT_MS);
  });

  const connectPromise = (async () => {
    try {
      if (__test_forceError) throw new Error('test-force-error');
      const connectFn = await getConnect();
      socket = connectFn({ hostname, port });
      await socket.opened;
      return 'OK: Status 200';
    } catch (err) {
      // タイムアウト後に閉じたソケットの失敗は、重ねて記録しない
      if (!timedOut) logCheckFailure(target, err);
      return 'ERROR: TCP Port Unreachable';
    }
  })();

  try {
    const result = await Promise.race([connectPromise, timeoutPromise]);
    if (timedOut) {
      logCheckFailure(target, `no connection within ${TCP_TIMEOUT_MS / 1000}s`);
    }
    return result;
  } finally {
    clearTimeout(timer);
    // タイムアウトした場合も含めて必ず閉じる。開いたままだと、その呼び出しが
    // 終わるまで同時接続の枠（6本）を占有し、後続のチェックを待たせてしまう
    await socket?.close().catch(() => {});
  }
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
    logCheckFailure(url, 'invalid URL format');
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
      logCheckFailure(url, `HTTP status ${response.status}`);
      return `ERROR: Status ${response.status}`;
    } catch (error: unknown) {
      logCheckFailure(url, error);
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

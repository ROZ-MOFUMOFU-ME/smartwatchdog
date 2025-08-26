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

// Check server status with a TCP connection, including retries and timeout.
const checkTcpStatus = async (
  hostname: string,
  port: number,
  tcpTimeout = 30000,
  retryOpts?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitterMs?: number;
  }
): Promise<{ status: string; attempts: number }> => {
  const maxRetries = retryOpts?.maxRetries ?? 0;
  const baseDelayMs = retryOpts?.baseDelayMs ?? 300;
  const maxDelayMs = retryOpts?.maxDelayMs ?? 5000;
  const jitterMs = retryOpts?.jitterMs ?? 150;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let attempt = 0;
  while (true) {
    attempt++;
    const timeoutPromise = new Promise<'TIMEOUT'>((resolve) =>
      setTimeout(() => resolve('TIMEOUT'), tcpTimeout)
    );
    const connectAttempt = (async () => {
      let socket;
      try {
        if (__test_forceError) throw new Error('test-force-error');
        const connectFn = await getConnect();
        socket = connectFn({ hostname, port });
        await socket.opened;
        return 'OK';
      } catch {
        return 'ERR';
      } finally {
        await socket?.close().catch(() => {});
      }
    })();
    const result = await Promise.race([connectAttempt, timeoutPromise]);
    if (result === 'OK') return { status: 'OK: Status 200', attempts: attempt };
    if (result === 'TIMEOUT') {
      if (attempt - 1 < maxRetries) {
        const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
        const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
        await sleep(delay + jitter);
        continue;
      }
      return { status: 'ERROR: TCP Timeout', attempts: attempt };
    }
    if (attempt - 1 < maxRetries) {
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
      await sleep(delay + jitter);
      continue;
    }
    return { status: 'ERROR: TCP Port Unreachable', attempts: attempt };
  }
};

// Check server status by determining the correct method (HTTP fetch or TCP connect)
const checkServerStatus = async (
  url: string,
  httpTimeout = 20000,
  tcpTimeout = 30000,
  retryOpts?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitterMs?: number;
  }
): Promise<{ status: string; attempts: number }> => {
  if (!url) {
    return { status: 'INVALID_URL', attempts: 0 };
  }

  let parsedUrl: URL;
  try {
    // Ensure we can parse it, even if it's just `host:port`
    parsedUrl = new URL(url.includes('://') ? url : `tcp://${url}`);
  } catch {
    return { status: 'INVALID_URL_FORMAT', attempts: 0 };
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
    const maxRetries = retryOpts?.maxRetries ?? 0;
    const baseDelayMs = retryOpts?.baseDelayMs ?? 300; // 初期待機
    const maxDelayMs = retryOpts?.maxDelayMs ?? 5000; // 上限
    const jitterMs = retryOpts?.jitterMs ?? 150; // ジッター

    let attempt = 0;
    while (true) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: AbortSignal.timeout(httpTimeout), // configurable via env
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
          },
        });
        if (response.body) response.body.cancel();
        if (response.status === 200)
          return { status: 'OK: Status 200', attempts: attempt + 1 };
        if (response.status >= 500 && attempt < maxRetries) {
          attempt++;
        } else {
          return {
            status: `ERROR: Status ${response.status}`,
            attempts: attempt + 1,
          };
        }
      } catch (error: unknown) {
        const isTimeout =
          typeof error === 'object' &&
          error &&
          'name' in error &&
          (error as { name?: unknown }).name === 'TimeoutError';
        if (isTimeout) {
          if (attempt < maxRetries) {
            attempt++;
          } else {
            return { status: 'ERROR: HTTP Timeout', attempts: attempt + 1 };
          }
        } else {
          if (attempt < maxRetries) {
            attempt++;
          } else {
            return { status: 'ERROR: Unreachable', attempts: attempt + 1 };
          }
        }
      }
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
      await new Promise((r) => setTimeout(r, delay + jitter));
    }
  }

  // For all others, perform a raw TCP socket connection test
  return checkTcpStatus(hostname, port, tcpTimeout, retryOpts);
};

// Generate current statuses from sheet rows by actively checking them
export const generateCurrentStatuses = async (
  rows: string[][],
  opts?: {
    httpTimeoutMs?: number;
    tcpTimeoutMs?: number;
    concurrency?: number;
    perRequestDelayMs?: number;
    retry?: {
      maxRetries?: number;
      baseDelayMs?: number;
      maxDelayMs?: number;
      jitterMs?: number;
    };
  }
): Promise<{
  currentStatuses: Record<string, ServerStatus>;
  removedStatuses: Record<string, boolean>;
}> => {
  const currentStatuses: Record<string, ServerStatus> = {};
  const removedStatuses: Record<string, boolean> = {};
  const lastUpdate = getCurrentTimestamp();

  const httpTimeout =
    opts?.httpTimeoutMs && opts.httpTimeoutMs > 0 ? opts.httpTimeoutMs : 20000;
  const tcpTimeout =
    opts?.tcpTimeoutMs && opts.tcpTimeoutMs > 0 ? opts.tcpTimeoutMs : 30000;

  const concurrency =
    opts?.concurrency && opts.concurrency > 0
      ? Math.min(opts.concurrency, rows.length)
      : rows.length; // デフォルトは従来通りフル並列
  const perDelay =
    opts?.perRequestDelayMs && opts.perRequestDelayMs > 0
      ? opts.perRequestDelayMs
      : 0;

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  let index = 0;
  const worker = async () => {
    while (true) {
      const i = index++;
      if (i >= rows.length) return;
      const row = rows[i];
      const [serverName, serverUrl] = row;
      const key = serverName || serverUrl;
      if (serverName && !serverUrl) {
        if (perDelay) await sleep(perDelay); // 形だけ delay
        continue;
      }
      if (key) {
        const res = await checkServerStatus(
          serverUrl,
          httpTimeout,
          tcpTimeout,
          opts?.retry
        );
        currentStatuses[key] = { status: res.status, lastUpdate };
      }
      if (perDelay) await sleep(perDelay);
    }
  };

  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return { currentStatuses, removedStatuses };
};

export { checkTcpStatus, checkServerStatus, __setTestForceError };

import type { ServerStatus } from '../types';

// "OK: ..." だけを正常とみなす（ERROR: ... や INVALID_URL_FORMAT は異常）
export const isOk = (status: string): boolean => status.startsWith('OK');

// 何回連続で失敗したら障害として確定するか（FAIL_THRESHOLD、既定2、最小1）
export function parseFailThreshold(value: string | undefined): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 2;
}

// 前回の状態（KV）と今回のチェック結果から、記録する状態と通知の要否を決める。
// - OK → 異常: threshold 回連続で失敗したときに確定して通知する。それまでは
//   前回のOKを保ったまま、失敗回数（failCount）だけを記録する。1回だけの一時的な
//   失敗（監視側のネットワークの瞬断や、サーバーの短い再起動）で通知しないため
// - 異常 → OK（復旧）と新しい行: すぐに確定して通知する
// - 異常のまま内容だけ変わった（Timeout ⇔ Unreachable など）: 通知しない。
//   表示は新しい内容にするが、lastUpdate は最初に落ちた時刻のまま保つ
export function decideStatus(
  prev: ServerStatus | undefined,
  current: ServerStatus,
  threshold: number
): { next: ServerStatus; notify: boolean } {
  if (!prev) return { next: current, notify: true };

  const prevOk = isOk(prev.status);
  if (isOk(current.status)) {
    if (prevOk) {
      // OKのまま。保留中の失敗回数があれば解除する
      return {
        next: { status: prev.status, lastUpdate: prev.lastUpdate },
        notify: false,
      };
    }
    return { next: current, notify: true };
  }

  if (!prevOk) {
    return {
      next: { status: current.status, lastUpdate: prev.lastUpdate },
      notify: false,
    };
  }

  const failCount = (prev.failCount ?? 0) + 1;
  if (failCount >= threshold) return { next: current, notify: true };
  return {
    next: { status: prev.status, lastUpdate: prev.lastUpdate, failCount },
    notify: false,
  };
}

// KVに保存する内容（status・lastUpdate・failCount）が同じか
export function sameStatus(
  a: ServerStatus | undefined,
  b: ServerStatus
): boolean {
  return (
    !!a &&
    a.status === b.status &&
    a.lastUpdate === b.lastUpdate &&
    (a.failCount ?? 0) === (b.failCount ?? 0)
  );
}

import {
  decideStatus,
  isOk,
  parseFailThreshold,
  sameStatus,
} from './transition';

const OK = 'OK: Status 200';
const T0 = '2026-11-01 00:00:00 (JST)';
const T1 = '2026-11-02 00:00:00 (JST)';

describe('decideStatus', () => {
  it('新しい行は、異常でもすぐに通知する', () => {
    const current = { status: 'ERROR: TCP Timeout', lastUpdate: T1 };
    expect(decideStatus(undefined, current, 2)).toEqual({
      next: current,
      notify: true,
    });
  });

  it('OKのままなら通知せず、前回の時刻を保つ', () => {
    const r = decideStatus(
      { status: OK, lastUpdate: T0 },
      { status: OK, lastUpdate: T1 },
      2
    );
    expect(r).toEqual({ next: { status: OK, lastUpdate: T0 }, notify: false });
  });

  it('OKの行が1回失敗しただけでは通知せず、失敗回数だけ記録する', () => {
    const r = decideStatus(
      { status: OK, lastUpdate: T0 },
      { status: 'ERROR: TCP Port Unreachable', lastUpdate: T1 },
      2
    );
    expect(r).toEqual({
      next: { status: OK, lastUpdate: T0, failCount: 1 },
      notify: false,
    });
  });

  it('連続して threshold 回失敗したら、障害として確定して通知する', () => {
    const current = { status: 'ERROR: TCP Port Unreachable', lastUpdate: T1 };
    const r = decideStatus(
      { status: OK, lastUpdate: T0, failCount: 1 },
      current,
      2
    );
    expect(r).toEqual({ next: current, notify: true });
  });

  it('保留中に成功したら、通知せずに失敗回数を消す', () => {
    const r = decideStatus(
      { status: OK, lastUpdate: T0, failCount: 1 },
      { status: OK, lastUpdate: T1 },
      2
    );
    expect(r).toEqual({ next: { status: OK, lastUpdate: T0 }, notify: false });
  });

  it('異常から復旧したら、すぐに通知する', () => {
    const current = { status: OK, lastUpdate: T1 };
    const r = decideStatus(
      { status: 'ERROR: Status 502', lastUpdate: T0 },
      current,
      2
    );
    expect(r).toEqual({ next: current, notify: true });
  });

  it('異常のまま内容だけ変わったら、通知せず、落ちた時刻を保つ', () => {
    const r = decideStatus(
      { status: 'ERROR: TCP Timeout', lastUpdate: T0 },
      { status: 'ERROR: TCP Port Unreachable', lastUpdate: T1 },
      2
    );
    expect(r).toEqual({
      next: { status: 'ERROR: TCP Port Unreachable', lastUpdate: T0 },
      notify: false,
    });
  });

  it('threshold が1なら、1回の失敗ですぐに通知する', () => {
    const current = { status: 'ERROR: HTTP Timeout', lastUpdate: T1 };
    const r = decideStatus({ status: OK, lastUpdate: T0 }, current, 1);
    expect(r).toEqual({ next: current, notify: true });
  });
});

describe('parseFailThreshold', () => {
  it('未設定や不正な値は2、それ以外は指定どおり', () => {
    expect(parseFailThreshold(undefined)).toBe(2);
    expect(parseFailThreshold('')).toBe(2);
    expect(parseFailThreshold('abc')).toBe(2);
    expect(parseFailThreshold('0')).toBe(2);
    expect(parseFailThreshold('1')).toBe(1);
    expect(parseFailThreshold('3')).toBe(3);
  });
});

describe('isOk / sameStatus', () => {
  it('OKで始まるものだけを正常とみなす', () => {
    expect(isOk(OK)).toBe(true);
    expect(isOk('ERROR: Status 500')).toBe(false);
    expect(isOk('INVALID_URL_FORMAT')).toBe(false);
  });

  it('failCount の有無も含めて比較する', () => {
    expect(
      sameStatus({ status: OK, lastUpdate: T0 }, { status: OK, lastUpdate: T0 })
    ).toBe(true);
    expect(
      sameStatus(
        { status: OK, lastUpdate: T0, failCount: 1 },
        { status: OK, lastUpdate: T0 }
      )
    ).toBe(false);
    expect(sameStatus(undefined, { status: OK, lastUpdate: T0 })).toBe(false);
  });
});

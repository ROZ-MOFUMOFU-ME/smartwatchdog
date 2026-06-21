// Cloudflare Workers用 GoogleサービスアカウントJWT生成・アクセストークン取得ユーティリティ

// PEM形式の秘密鍵をCryptoKeyに変換
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemHeader = /-----BEGIN PRIVATE KEY-----/;
  const pemFooter = /-----END PRIVATE KEY-----/;
  // ヘッダー・フッター・改行・空白を厳密に除去
  const pemContents = pem
    .replace(pemHeader, '')
    .replace(pemFooter, '')
    .replace(/\r?\n|\r/g, '')
    .replace(/\s+/g, '');
  // base64として不正な文字が混入していないかチェック
  if (!/^[A-Za-z0-9+/=]+$/.test(pemContents)) {
    throw new Error('Invalid base64 in private key');
  }
  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    binaryDer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

// JWT生成
async function createJWT(
  clientEmail: string,
  privateKey: string,
  scope: string
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };
  const payload = {
    iss: clientEmail,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    exp,
    iat,
  };
  function base64url(obj: object) {
    return btoa(JSON.stringify(obj))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }
  const encHeader = base64url(header);
  const encPayload = base64url(payload);
  const unsignedToken = `${encHeader}.${encPayload}`;
  const key = await importPrivateKey(privateKey);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsignedToken)
  );
  const b64sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${unsignedToken}.${b64sig}`;
}

// JWTでアクセストークン取得
// kvを渡すと取得済みトークンをKVにキャッシュし、サブリクエスト数を削減する。
// KVの読み書きで失敗しても、その都度新規発行にフォールバックするだけで致命的にはしない。
export async function getGoogleAccessToken(
  clientEmail: string,
  privateKey: string,
  scope: string,
  kv?: KVNamespace
): Promise<string> {
  const cacheKey = `gtoken:${clientEmail}:${scope}`;

  // 1. キャッシュ確認（kv指定時のみ）
  if (kv) {
    try {
      const cached = await kv.get(cacheKey);
      if (cached) return cached;
    } catch {
      // KV読み取り失敗時は新規発行にフォールバック
    }
  }

  // 2. キャッシュミス時は従来どおり発行
  const jwt = await createJWT(clientEmail, privateKey, scope);
  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = (await resp.json()) as {
    access_token?: string;
    expires_in?: number;
    [key: string]: unknown;
  };
  if (!data.access_token)
    throw new Error('Failed to get access token: ' + JSON.stringify(data));

  // 3. 取得したトークンをKVへ保存（有効期限の5分前で失効させる）
  if (kv) {
    try {
      const expirationTtl = Math.max(60, (data.expires_in ?? 3600) - 300);
      await kv.put(cacheKey, data.access_token, { expirationTtl });
    } catch {
      // KV書き込み失敗は無視（トークン自体は取得済み）
    }
  }

  return data.access_token;
}

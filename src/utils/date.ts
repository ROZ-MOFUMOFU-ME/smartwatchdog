// JST（日本標準時）の現在時刻を返すユーティリティ
export const getCurrentTimestamp = (): string => {
  const now = new Date();
  now.setHours(now.getHours() + 9);
  return now.toISOString().replace('T', ' ').split('.')[0] + ' (JST)';
};

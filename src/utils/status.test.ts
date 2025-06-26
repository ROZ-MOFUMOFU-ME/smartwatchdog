import { generateCurrentStatuses } from './status';

describe('generateCurrentStatuses', () => {
  it('サーバー名とURLがある場合、currentStatusesに格納される', async () => {
    const rows = [['Server1', 'https://a.com', 'OK', '2024-01-01 00:00:00']];
    const { currentStatuses } = await generateCurrentStatuses(rows);
    expect(currentStatuses['Server1']).toEqual({
      status: 'OK',
      lastUpdate: '2024-01-01 00:00:00',
    });
  });

  it('サーバー名が空でURLのみの場合、URLがキーになる', async () => {
    const rows = [['', 'https://c.com', 'OK', '2024-01-01 02:00:00']];
    const { currentStatuses } = await generateCurrentStatuses(rows);
    expect(currentStatuses['https://c.com']).toEqual({
      status: 'OK',
      lastUpdate: '2024-01-01 02:00:00',
    });
  });

  it('サーバー名もURLも空の場合はcurrentStatusesに含まれない', async () => {
    const rows = [['', '', '', '']];
    const { currentStatuses } = await generateCurrentStatuses(rows);
    expect(Object.keys(currentStatuses)).toHaveLength(0);
  });
});

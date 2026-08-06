import { groupMemoriesByUpdatedAt } from '../../../renderer/components/memory_view_model';

describe('记忆页面时间分组', () => {
    const memory = (uid: string, updatedAt: string) => ({
        scope: 'workspace' as const,
        uid,
        title: uid,
        content: uid,
        heat: 0,
        createdAt: updatedAt,
        updatedAt
    });

    test('按最后更新时间归入最近一周、最近一月和更久，并在组内倒序', () => {
        const groups = groupMemoriesByUpdatedAt(
            [
                memory('month-old', '2026-07-15T00:00:00.000Z'),
                memory('newer', '2026-08-05T10:00:00.000Z'),
                memory('old', '2026-06-01T00:00:00.000Z'),
                memory('week-old', '2026-08-01T00:00:00.000Z')
            ],
            new Date('2026-08-05T12:00:00.000Z')
        );

        expect(groups.map((group) => group.id)).toEqual(['recentWeek', 'recentMonth', 'older']);
        expect(groups[0].memories.map((item) => item.uid)).toEqual(['newer', 'week-old']);
        expect(groups[1].memories.map((item) => item.uid)).toEqual(['month-old']);
        expect(groups[2].memories.map((item) => item.uid)).toEqual(['old']);
    });

    test('空分组不会出现在结果中', () => {
        const groups = groupMemoriesByUpdatedAt(
            [memory('recent', '2026-08-05T10:00:00.000Z')],
            new Date('2026-08-05T12:00:00.000Z')
        );

        expect(groups).toHaveLength(1);
        expect(groups[0].id).toBe('recentWeek');
    });
});

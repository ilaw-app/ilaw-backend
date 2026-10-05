import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  communityPost: {
    findMany: vi.fn(),
  },
  communityPollVote: {
    groupBy: vi.fn(),
  },
}));

vi.mock('../src/prisma/client', () => ({ default: prismaMock }));
vi.mock('../src/services/ai.service', () => ({
  diagnose: vi.fn(),
  loadManualCache: vi.fn(),
}));

const ACCESS_SECRET = 'community-my-posts-test-secret';
let app: Express;

function authorization(userId: string) {
  return `Bearer ${jwt.sign({ userId }, ACCESS_SECRET, { expiresIn: '5m' })}`;
}

beforeAll(async () => {
  process.env.JWT_ACCESS_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = 'community-my-posts-refresh-secret';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  app = (await import('../src/app')).default;
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.communityPollVote.groupBy.mockResolvedValue([]);
  prismaMock.communityPost.findMany.mockResolvedValue([
    {
      id: 7,
      title: '내가 쓴 글',
      content: '본문',
      poll: null,
      imageUrls: ['https://cdn.test/a.png'],
      createdAt: new Date('2026-08-02T09:00:00.000Z'),
      updatedAt: new Date('2026-08-02T09:00:00.000Z'),
      _count: { likes: 2, comments: 3, bookmarks: 1 },
    },
  ]);
});

describe('GET /community/my-posts', () => {
  it('인증 없이는 접근할 수 없다', async () => {
    await request(app).get('/community/my-posts').expect(401);
    expect(prismaMock.communityPost.findMany).not.toHaveBeenCalled();
  });

  it('로그인 사용자가 작성한 노출 상태의 글만 조회한다', async () => {
    await request(app)
      .get('/community/my-posts')
      .set('Authorization', authorization('me'))
      .expect(200);

    expect(prismaMock.communityPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { authorId: 'me', status: 'visible' } }),
    );
  });

  it('목록과 동일한 형태로 반환한다', async () => {
    const res = await request(app)
      .get('/community/my-posts')
      .set('Authorization', authorization('me'))
      .expect(200);

    expect(res.body).toEqual([
      {
        id: 7,
        nickname: '익명',
        title: '내가 쓴 글',
        content: '본문',
        imageUrls: ['https://cdn.test/a.png'],
        createdAt: '2026-08-02T09:00:00.000Z',
        updatedAt: '2026-08-02T09:00:00.000Z',
        likes: 2,
        bookmarks: 1,
        comments: 3,
        poll: null,
      },
    ]);
  });

  it('목록에서 감추는 댓글(욕설 블라인드·작성자 삭제)은 댓글 수에서도 제외한다', async () => {
    await request(app)
      .get('/community/my-posts')
      .set('Authorization', authorization('me'))
      .expect(200);

    const [{ select }] = prismaMock.communityPost.findMany.mock.calls[0];
    expect(select._count.select.comments).toEqual({
      where: { status: { notIn: ['hidden', 'deleted'] } },
    });
  });
});

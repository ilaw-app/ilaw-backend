import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  communityPost: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  communityComment: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
  },
  communityCommentReport: { create: vi.fn(), count: vi.fn() },
  communityPostReport: { create: vi.fn(), count: vi.fn() },
}));

const moderateAndBlind = vi.hoisted(() => vi.fn());
const createNotification = vi.hoisted(() => vi.fn());

vi.mock('../src/prisma/client', () => ({ default: prismaMock }));
vi.mock('../src/services/moderation.service', () => ({ moderateAndBlind }));
vi.mock('../src/services/notification.service', () => ({ createNotification }));

import { containsProfanity } from '../src/services/profanity';
import * as communityService from '../src/services/community.service';

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (operation: (tx: typeof prismaMock) => unknown) => operation(prismaMock));
  prismaMock.communityComment.findMany.mockResolvedValue([]);
});

describe('로컬 금칙어 사전 (1차 필터)', () => {
  it('명백한 비속어를 잡는다', () => {
    expect(containsProfanity('이 시발 뭐야')).toBe(true);
    expect(containsProfanity('개새끼')).toBe(true);
    expect(containsProfanity('you are an asshole')).toBe(true);
  });

  it('공백·특수문자·연속 반복문자로 우회해도 잡는다', () => {
    expect(containsProfanity('시 발')).toBe(true);
    expect(containsProfanity('시-발')).toBe(true);
    expect(containsProfanity('개새끼끼끼')).toBe(true);
  });

  it('초성 축약도 잡는다', () => {
    expect(containsProfanity('ㅅㅂ 뭐임')).toBe(true);
    expect(containsProfanity('ㅅ ㅂ')).toBe(true);
    expect(containsProfanity('ㅈㄴ 짜증')).toBe(true);
    expect(containsProfanity('ㄱㅅㄲ')).toBe(true);
  });

  it('정상 문장은 통과시킨다', () => {
    expect(containsProfanity('오늘 날씨가 좋네요')).toBe(false);
    expect(containsProfanity('반사 스티커')).toBe(false); // 완성형 '반사'는 초성 ㅂㅅ로 분해하지 않음
    expect(containsProfanity('')).toBe(false);
    expect(containsProfanity(null)).toBe(false);
  });
});

describe('작성 시 하드블록 + 게시 후 비동기 검열', () => {
  it('금칙어 댓글은 저장하지 않고 profanity_blocked를 반환한다', async () => {
    const result = await communityService.createComment(1, 'user-1', '시발 뭐야');

    expect(result).toEqual({
      error: 'profanity_blocked',
      details: { content: [{ word: '시발', start: 0, end: 2 }] },
    });
    expect(prismaMock.communityComment.create).not.toHaveBeenCalled();
    expect(moderateAndBlind).not.toHaveBeenCalled();
  });

  it('정상 댓글은 저장하고 백그라운드 검열을 예약한다', async () => {
    prismaMock.communityPost.findUnique.mockResolvedValue({ id: 1, authorId: 'author-1', status: 'visible' });
    prismaMock.communityComment.create.mockResolvedValue({
      id: 10, postId: 1, authorId: 'user-1', parentId: null, content: '좋은 글이네요',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    });

    const result = await communityService.createComment(1, 'user-1', '좋은 글이네요');

    expect(result).toHaveProperty('data');
    expect(prismaMock.communityComment.create).toHaveBeenCalled();
    expect(moderateAndBlind).toHaveBeenCalledWith({
      kind: 'comment', id: 10, text: '좋은 글이네요', authorId: 'user-1',
    });
  });

  it('금칙어 게시글도 저장 없이 차단한다', async () => {
    const result = await communityService.createPost('user-1', { title: '개새끼', content: '내용' });

    expect(result).toEqual({
      error: 'profanity_blocked',
      details: { title: [{ word: '개새끼', start: 0, end: 3 }] },
    });
    expect(prismaMock.communityPost.create).not.toHaveBeenCalled();
  });

  it('게시글 수정에서도 금칙어를 저장 전에 차단한다', async () => {
    prismaMock.communityPost.findUnique.mockResolvedValue({ authorId: 'user-1', poll: null });

    const result = await communityService.updatePost(1, 'user-1', { content: '시-발 수정' });

    expect(result).toEqual({
      error: 'profanity_blocked',
      details: { content: [{ word: '시-발', start: 0, end: 3 }] },
    });
    expect(prismaMock.communityPost.update).not.toHaveBeenCalled();
    expect(moderateAndBlind).not.toHaveBeenCalled();
  });

  it('정상 게시글 수정도 저장 후 AI 검열을 예약한다', async () => {
    prismaMock.communityPost.findUnique.mockResolvedValue({ authorId: 'user-1', poll: null });
    prismaMock.communityPost.update.mockResolvedValue({
      id: 1,
      title: '수정 제목',
      content: '수정 본문',
      imageUrls: [],
      poll: null,
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    });

    const result = await communityService.updatePost(1, 'user-1', { title: '수정 제목' });

    expect(result).toHaveProperty('data');
    expect(moderateAndBlind).toHaveBeenCalledWith({
      kind: 'post', id: 1, text: '수정 제목\n수정 본문', authorId: 'user-1',
    });
  });
});

describe('댓글 신고 → 서로 다른 3명 누적 시 soft delete', () => {
  beforeEach(() => {
    prismaMock.communityComment.findUnique.mockResolvedValue({ authorId: 'author-1', status: 'visible' });
    prismaMock.communityCommentReport.create.mockResolvedValue({ id: 1 });
    prismaMock.communityComment.updateMany.mockResolvedValue({ count: 1 });
  });

  it('신고자가 2명이면 삭제하지 않는다', async () => {
    prismaMock.communityCommentReport.count.mockResolvedValue(2);

    const result = await communityService.reportComment(5, 'reporter-2');

    expect(result).toEqual({ data: { reported: true, count: 2, deleted: false } });
    expect(prismaMock.communityComment.updateMany).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('서로 다른 3명째 신고에서 삭제하고 작성자에게 알림을 보낸다', async () => {
    prismaMock.communityCommentReport.count.mockResolvedValue(3);

    const result = await communityService.reportComment(5, 'reporter-3');

    expect(result).toEqual({ data: { reported: true, count: 3, deleted: true } });
    expect(prismaMock.communityComment.updateMany).toHaveBeenCalledWith({
      where: { id: 5, status: { notIn: ['deleted', 'removed'] } },
      data: { status: 'removed' },
    });
    expect(createNotification).toHaveBeenCalledWith(
      'author-1', 'community_removed', expect.any(String), expect.any(String), 5,
    );
  });

  it('같은 사람의 중복 신고는 already_reported로 막고 카운트하지 않는다', async () => {
    prismaMock.communityCommentReport.create.mockRejectedValue(uniqueViolation());

    const result = await communityService.reportComment(5, 'reporter-1');

    expect(result).toEqual({ error: 'already_reported' });
    expect(prismaMock.communityCommentReport.count).not.toHaveBeenCalled();
    expect(prismaMock.communityComment.updateMany).not.toHaveBeenCalled();
  });

  it('본인 댓글은 신고할 수 없다', async () => {
    const result = await communityService.reportComment(5, 'author-1');

    expect(result).toEqual({ error: 'cannot_report_self' });
    expect(prismaMock.communityCommentReport.create).not.toHaveBeenCalled();
  });

  it('이미 삭제된 댓글은 not_found로 막는다', async () => {
    prismaMock.communityComment.findUnique.mockResolvedValue({ authorId: 'author-1', status: 'deleted' });

    const result = await communityService.reportComment(5, 'reporter-1');

    expect(result).toEqual({ error: 'not_found' });
  });
});

describe('게시글 신고 → 3명 누적 시 soft delete', () => {
  it('3명째 신고에서 삭제하고 작성자에게 알림을 보낸다', async () => {
    prismaMock.communityPost.findUnique.mockResolvedValue({ authorId: 'author-1', status: 'visible' });
    prismaMock.communityPostReport.create.mockResolvedValue({ id: 1 });
    prismaMock.communityPostReport.count.mockResolvedValue(3);
    prismaMock.communityPost.updateMany.mockResolvedValue({ count: 1 });

    const result = await communityService.reportPost(7, 'reporter-3');

    expect(result).toEqual({ data: { reported: true, count: 3, deleted: true } });
    expect(prismaMock.communityPost.updateMany).toHaveBeenCalledWith({
      where: { id: 7, status: { notIn: ['deleted', 'removed'] } },
      data: { status: 'removed' },
    });
    expect(createNotification).toHaveBeenCalledWith(
      'author-1', 'community_removed', expect.any(String), expect.any(String), 7,
    );
  });
});

describe('비공개/삭제 게시글의 댓글 공개 조회', () => {
  it.each(['hidden', 'removed', 'deleted'])('%s 게시글의 댓글은 공개하지 않는다', async (status) => {
    prismaMock.communityPost.findUnique.mockResolvedValue({ authorId: 'post-author', status });
    prismaMock.communityComment.findMany.mockResolvedValue([
      {
        id: 1,
        authorId: 'author-1',
        parentId: null,
        status: 'visible',
        content: '노출되면 안 되는 댓글',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        author: { id: 'author-1', nickname: '닉' },
        _count: { likes: 0 },
      },
    ]);

    await expect(communityService.listComments(1)).resolves.toEqual([]);
  });
});

describe('비공개/삭제 댓글 표시 마스킹', () => {
  function commentRow(over: Partial<{ id: number; status: string; parentId: number | null }>) {
    return {
      id: over.id ?? 1,
      authorId: 'author-1',
      parentId: over.parentId ?? null,
      status: over.status ?? 'visible',
      content: '원문 내용',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      author: { id: 'author-1', nickname: '닉' },
      _count: { likes: 5 },
    };
  }

  beforeEach(() => {
    prismaMock.communityPost.findUnique.mockResolvedValue({ authorId: 'post-author' });
  });

  it.each(['hidden', 'deleted'])('%s 댓글은 안내문도 남기지 않고 목록에서 뺀다', async (status) => {
    prismaMock.communityComment.findMany.mockResolvedValue([
      commentRow({ id: 1, status }),
      commentRow({ id: 2, status: 'visible' }),
    ]);

    const roots = await communityService.listComments(1);

    expect(roots.map((c) => c.id)).toEqual([2]);
  });

  it('신고삭제(removed)만 안내문으로 남고 원문·좋아요는 가린다', async () => {
    prismaMock.communityComment.findMany.mockResolvedValue([commentRow({ id: 1, status: 'removed' })]);

    const [comment] = await communityService.listComments(1);

    expect(comment.content).toBe('신고가 누적되어 삭제된 댓글입니다.');
    expect(comment.likes).toBe(0);
  });

  it('감춘 댓글의 답글은 최상위로 올라오지 않고 함께 사라진다', async () => {
    prismaMock.communityComment.findMany.mockResolvedValue([
      commentRow({ id: 1, status: 'hidden' }),
      commentRow({ id: 2, status: 'visible', parentId: 1 }),
      commentRow({ id: 3, status: 'visible' }),
    ]);

    const roots = await communityService.listComments(1);

    expect(roots.map((c) => c.id)).toEqual([3]);
  });

  it('삭제된 부모 댓글은 안내문으로 남고 답글 스레드는 유지된다', async () => {
    prismaMock.communityComment.findMany.mockResolvedValue([
      commentRow({ id: 1, status: 'removed' }),
      commentRow({ id: 2, status: 'visible', parentId: 1 }),
    ]);

    const roots = await communityService.listComments(1);

    expect(roots).toHaveLength(1);
    expect(roots[0].content).toBe('신고가 누적되어 삭제된 댓글입니다.');
    expect(roots[0].replies).toHaveLength(1);
    expect(roots[0].replies[0].content).toBe('원문 내용');
  });
});

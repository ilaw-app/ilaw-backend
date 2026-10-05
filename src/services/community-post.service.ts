import prisma from '../prisma/client';
import { checkProfanityFields } from './profanity';
import { moderateAndBlind } from './moderation.service';
import { ANONYMOUS_POST_AUTHOR, HIDDEN_POST_STATUSES, DROPPED_COMMENT_STATUSES } from './community-shared';
import { buildCommentTree, buildLabelMapFromComments } from './community-presenter';
import { formatPoll, getVoteCounts, parsePollInput, PollDefinition, samePollOptions } from './community-poll.service';
import { runCommunitySerializableTransaction } from './community-transaction';

export async function listPosts(page: number, limit: number) {
  const skip = (page - 1) * limit;
  const [posts, total] = await Promise.all([
    prisma.communityPost.findMany({
      skip,
      take: limit,
      where: { status: 'visible' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        content: true,
        poll: true,
        imageUrls: true,
        createdAt: true,
        updatedAt: true,
        author: { select: { nickname: true } },
        _count: {
          select: {
            likes: true,
            comments: { where: { status: { notIn: DROPPED_COMMENT_STATUSES } } },
            bookmarks: true,
          },
        },
      },
    }),
    prisma.communityPost.count({ where: { status: 'visible' } }),
  ]);
  const voteCounts = await getVoteCounts(posts.map((post) => post.id));

  return {
    posts: posts.map((p) => ({
      id: p.id,
      nickname: ANONYMOUS_POST_AUTHOR,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      title: p.title,
      content: p.content,
      imageUrls: p.imageUrls,
      likes: p._count.likes,
      bookmarks: p._count.bookmarks,
      comments: p._count.comments,
      poll: formatPoll(p.poll, voteCounts.get(p.id)),
    })),
    total,
    page,
    limit,
  };
}

export async function getPost(id: number, userId?: string) {
  const post = await prisma.communityPost.findUnique({
    where: { id },
    include: {
      author: { select: { nickname: true } },
      _count: { select: { likes: true, bookmarks: true } },
      comments: {
        orderBy: { createdAt: 'asc' },
        include: {
          author: { select: { id: true, nickname: true } },
          likes: userId ? { where: { userId }, select: { userId: true } } : false,
          _count: { select: { likes: true } },
        },
      },
    },
  });
  if (!post) return null;
  // 비공개/삭제된 게시글은 피드에서도 상세에서도 노출하지 않는다.
  if (HIDDEN_POST_STATUSES.includes(post.status)) return null;

  const [liked, bookmarked, vote, voteCounts] = await Promise.all([
    userId
      ? prisma.communityLike.findUnique({ where: { userId_postId: { userId, postId: id } } })
      : Promise.resolve(null),
    userId
      ? prisma.communityBookmark.findUnique({ where: { userId_postId: { userId, postId: id } } })
      : Promise.resolve(null),
    userId
      ? prisma.communityPollVote.findUnique({ where: { userId_postId: { userId, postId: id } } })
      : Promise.resolve(null),
    getVoteCounts([id]),
  ]);

  const labels = buildLabelMapFromComments(post.comments, post.authorId);

  return {
    id: post.id,
    nickname: ANONYMOUS_POST_AUTHOR,
    isAuthor: userId && post.authorId ? post.authorId === userId : false,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    title: post.title,
    content: post.content,
    imageUrls: post.imageUrls,
    likes: post._count.likes,
    liked: !!liked,
    bookmarks: post._count.bookmarks,
    bookmarked: !!bookmarked,
    poll: formatPoll(post.poll, voteCounts.get(id), vote?.optionIndex),
    comments: buildCommentTree(post.comments, labels, post.authorId, userId),
  };
}

export async function createPost(
  userId: string,
  data: { title: string; content?: string; poll?: object; imageUrls?: string[] },
) {
  // 1차 필터: 로컬 금칙어 사전에 걸리면 작성 자체를 거부한다.
  const profanity = checkProfanityFields({ title: data.title, content: data.content });
  if (profanity) return { error: 'profanity_blocked' as const, details: profanity };

  let poll: PollDefinition | undefined;
  if (data.poll !== undefined) {
    const parsed = parsePollInput(data.poll);
    if ('error' in parsed) return parsed;
    poll = parsed.data;
  }

  const post = await prisma.communityPost.create({
    data: {
      authorId: userId,
      title: data.title,
      content: data.content,
      poll,
      imageUrls: data.imageUrls ?? [],
    },
    select: { id: true, title: true, createdAt: true },
  });

  // 2차 필터: 게시 후 백그라운드 검열(클린봇 방식). 응답을 막지 않는다.
  void moderateAndBlind({
    kind: 'post',
    id: post.id,
    text: [data.title, data.content].filter(Boolean).join('\n'),
    authorId: userId,
  });

  return { data: post };
}

export async function updatePost(
  id: number,
  userId: string,
  data: { title?: string; content?: string; imageUrls?: string[]; poll?: object },
) {
  const profanity = checkProfanityFields({ title: data.title, content: data.content });
  if (profanity) return { error: 'profanity_blocked' as const, details: profanity };

  const result = await runCommunitySerializableTransaction(
    (operation, options) => prisma.$transaction(operation, options),
    async (tx) => {
      const post = await tx.communityPost.findUnique({
        where: { id },
        select: { authorId: true, poll: true },
      });
      if (!post) return { error: 'not_found' as const };
      if (post.authorId !== userId) return { error: 'forbidden' as const };

      let poll: PollDefinition | undefined;
      if (data.poll !== undefined) {
        const parsed = parsePollInput(data.poll);
        if ('error' in parsed) return parsed;
        poll = parsed.data;

        if (!samePollOptions(post.poll, poll)) {
          const voteCount = await tx.communityPollVote.count({ where: { postId: id } });
          if (voteCount > 0) return { error: 'poll_locked' as const };
        } else {
          poll = undefined;
        }
      }

      const updated = await tx.communityPost.update({
        where: { id },
        data: {
          title: data.title,
          content: data.content,
          ...(data.imageUrls !== undefined && { imageUrls: data.imageUrls }),
          ...(poll !== undefined && { poll }),
        },
        select: { id: true, title: true, content: true, imageUrls: true, poll: true, updatedAt: true },
      });
      return { data: updated };
    },
  );

  const updated = 'data' in result ? result.data : undefined;
  if (updated) {
    void moderateAndBlind({
      kind: 'post',
      id: updated.id,
      text: [updated.title, updated.content].filter(Boolean).join('\n'),
      authorId: userId,
    });
  }

  return result;
}

export async function deletePost(id: number, userId: string) {
  const post = await prisma.communityPost.findUnique({ where: { id }, select: { authorId: true, status: true } });
  if (!post || post.status === 'deleted' || post.status === 'removed') return { error: 'not_found' as const };
  if (post.authorId !== userId) return { error: 'forbidden' as const };

  await prisma.communityPost.update({ where: { id }, data: { status: 'deleted' } });
  return { data: true };
}


export async function getMyPosts(userId: string) {
  const posts = await prisma.communityPost.findMany({
    where: { authorId: userId, status: 'visible' },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      title: true,
      content: true,
      poll: true,
      imageUrls: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          likes: true,
          comments: { where: { status: { notIn: DROPPED_COMMENT_STATUSES } } },
          bookmarks: true,
        },
      },
    },
  });
  const voteCounts = await getVoteCounts(posts.map((post) => post.id));

  return posts.map((p) => ({
    id: p.id,
    nickname: ANONYMOUS_POST_AUTHOR,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    title: p.title,
    content: p.content,
    imageUrls: p.imageUrls,
    likes: p._count.likes,
    bookmarks: p._count.bookmarks,
    comments: p._count.comments,
    poll: formatPoll(p.poll, voteCounts.get(p.id)),
  }));
}
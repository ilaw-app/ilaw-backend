import prisma from '../prisma/client';
import { expandQuery } from './synonyms';
import { scoreAndRank } from './search.util';
import { Pagination, paginationArgs } from '../utils/validation';
import { embedQnaPost } from './ai.qna';
import { safeAiErrorFields } from './ai.logging';
import { logger } from '../middlewares/logging';

export async function listQAPosts(userId?: string, pagination: Pagination = { page: 1, limit: 20 }) {
  const posts = await prisma.qnAPost.findMany({
    ...paginationArgs(pagination),
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      title: true,
      content: true,
      category: true,
      status: true,
      // 목록 썸네일용. 없으면 클라이언트가 항목마다 상세를 다시 조회해야 한다(N+1).
      imageUrls: true,
      createdAt: true,
      author: { select: { nickname: true } },
      _count: { select: { scraps: true } },
      ...(userId ? { scraps: { where: { userId }, select: { id: true } } } : {}),
    },
  });

  return posts.map(({ _count, scraps, ...p }: any) => ({
    ...p,
    scrapCount: _count.scraps,
    scrapped: userId ? (scraps?.length ?? 0) > 0 : undefined,
  }));
}

function calcAge(birthDate: Date): number {
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const hasBirthdayPassed =
    today.getMonth() > birthDate.getMonth() ||
    (today.getMonth() === birthDate.getMonth() && today.getDate() >= birthDate.getDate());
  return hasBirthdayPassed ? age : age - 1;
}

export type QAPostDetailDto = {
  id: number;
  title: string;
  content: string;
  category: string;
  status: string;
  imageUrls: string[];
  createdAt: Date;
  updatedAt: Date;
  author: {
    nickname: '익명';
    age?: number | null;
    region?: string | null;
    gender?: string | null;
  };
  answer: {
    id: number;
    content: string;
    createdAt: Date;
    updatedAt: Date;
    lawyer: {
      nickname: string | null;
      role: string;
      affiliation: string | null;
    } | null;
    isMyAnswer: boolean;
  } | null;
  isAuthor: boolean;
};

export async function getQAPostDetail(id: number, viewerId?: string): Promise<QAPostDetailDto | null> {
  const viewer = viewerId
    ? await prisma.user.findUnique({ where: { id: viewerId }, select: { role: true } })
    : null;

  const post = await prisma.qnAPost.findUnique({
    where: { id },
    select: {
      id: true,
      authorId: true,
      title: true,
      content: true,
      category: true,
      status: true,
      imageUrls: true,
      createdAt: true,
      updatedAt: true,
      author: { select: { nickname: true, birthDate: true, region: true, gender: true } },
      answer: {
        select: {
          id: true,
          lawyerId: true,
          content: true,
          createdAt: true,
          updatedAt: true,
          lawyer: { select: { nickname: true, role: true, affiliation: true } },
        },
      },
    },
  });

  if (!post) return null;

  const author = viewer?.role === 'lawyer' && post.author
    ? {
        nickname: '익명' as const,
        age: post.author.birthDate ? calcAge(post.author.birthDate) : null,
        region: post.author.region,
        gender: post.author.gender,
      }
    : { nickname: '익명' as const };

  const answer = post.answer
    ? {
        id: post.answer.id,
        content: post.answer.content,
        createdAt: post.answer.createdAt,
        updatedAt: post.answer.updatedAt,
        lawyer: post.answer.lawyer
          ? {
              nickname: post.answer.lawyer.nickname,
              role: post.answer.lawyer.role,
              affiliation: post.answer.lawyer.affiliation,
            }
          : null,
        isMyAnswer: Boolean(viewerId && post.answer.lawyerId === viewerId),
      }
    : null;

  return {
    id: post.id,
    title: post.title,
    content: post.content,
    category: post.category,
    status: post.status,
    imageUrls: post.imageUrls,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    author,
    answer,
    isAuthor: Boolean(viewerId && post.authorId === viewerId),
  };
}

export async function getQAPostAnswerState(id: number) {
  return prisma.qnAPost.findUnique({
    where: { id },
    select: { answer: { select: { id: true } } },
  });
}

// AI 챗봇 근거용 임베딩 갱신. 답변 등록·수정 응답을 늦추거나 실패시키지 않도록 분리해서 돌린다
// (플래그가 꺼져 있으면 no-op, 누락분은 ai:embed 백필이 메운다).
function refreshQnaEmbedding(postId: number): void {
  void embedQnaPost(postId).catch((error: unknown) => {
    logger.error({ event: 'ai_qna_embed_failed', postId, ...safeAiErrorFields(error, 'qna_embed') });
  });
}

export async function updateQAAnswer(postId: number, lawyerId: string, content: string): Promise<boolean> {
  const lawyer = await prisma.user.findUnique({ where: { id: lawyerId }, select: { role: true } });
  if (lawyer?.role !== 'lawyer') return false;

  const answer = await prisma.qnAAnswer.findUnique({ where: { postId }, select: { lawyerId: true } });
  if (!answer || answer.lawyerId !== lawyerId) return false;
  await prisma.qnAAnswer.update({ where: { postId }, data: { content } });
  refreshQnaEmbedding(postId);
  return true;
}

export async function createQAPost(authorId: string, title: string, content: string, category: string, imageUrls: string[] = []) {
  return prisma.qnAPost.create({
    data: { authorId, title, content, category, imageUrls },
  });
}

export async function searchQAPosts(query: string, debug = false) {
  const terms = await expandQuery(query);

  const posts = await prisma.qnAPost.findMany({
    where: {
      OR: [
        ...terms.flatMap((term) => [
          { title: { contains: term } },
          { content: { contains: term } },
        ]),
        ...terms.map((term) => ({
          answer: { content: { contains: term } },
        })),
      ],
    },
    select: {
      id: true,
      title: true,
      content: true,
      category: true,
      status: true,
      imageUrls: true,
      createdAt: true,
      author: { select: { nickname: true } },
      answer: { select: { content: true } },
    },
    take: 100,
  });

  const ranked = scoreAndRank(
    posts,
    terms,
    (p) => [[p.title, 2], [p.content, 1.5], [p.answer?.content ?? '', 1]],
    { phrase: query },
  );
  const results = ranked.map(({ score, ...rest }) => debug ? { ...rest, score } : rest);

  return { results, expandedTerms: terms };
}

export async function listUserQAPosts(authorId: string, pagination: Pagination = { page: 1, limit: 20 }) {
  return prisma.qnAPost.findMany({
    ...paginationArgs(pagination),
    where: { authorId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      title: true,
      category: true,
      status: true,
      imageUrls: true,
      createdAt: true,
      author: { select: { nickname: true } },
    },
  });
}

export async function listLawyerAnswers(lawyerId: string, pagination: Pagination = { page: 1, limit: 20 }) {
  const answers = await prisma.qnAAnswer.findMany({
    ...paginationArgs(pagination),
    where: { lawyerId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      createdAt: true,
      post: {
        select: {
          id: true,
          title: true,
          content: true,
          category: true,
          createdAt: true,
        },
      },
    },
  });
  return answers.map(a => ({
    id: a.post.id,
    title: a.post.title,
    content: a.post.content,
    category: a.post.category,
    createdAt: a.post.createdAt,
    answeredAt: a.createdAt,
  }));
}

export async function deleteQAPost(id: number, userId: string): Promise<boolean> {
  const post = await prisma.qnAPost.findUnique({ where: { id }, select: { authorId: true } });
  if (!post || post.authorId !== userId) return false;
  // The answer is removed automatically via QnAAnswer.post onDelete: Cascade.
  await prisma.qnAPost.delete({ where: { id } });
  return true;
}

export async function createQAAnswer(postId: number, lawyerId: string, content: string) {
  const lawyer = await prisma.user.findUnique({ where: { id: lawyerId }, select: { role: true } });
  if (lawyer?.role !== 'lawyer') return null;

  const [answer] = await prisma.$transaction([
    prisma.qnAAnswer.create({ data: { postId, lawyerId, content } }),
    prisma.qnAPost.update({ where: { id: postId }, data: { status: 'answered' } }),
  ]);
  refreshQnaEmbedding(postId);
  return answer;
}

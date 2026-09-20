import prisma from '../prisma/client';
import { EMBED_VERSION, embedInputHash, embedText, toVectorLiteral } from './ai.embeddings';
import { logger } from '../middlewares/logging';
import { safeAiErrorFields } from './ai.logging';

// Q&A 게시판을 AI 챗봇의 두 번째 근거로 쓴다. 원칙:
//  - 변호사 답변이 달린 글만 대상이다. 법적 근거는 "변호사 답변"이고, 질문 본문은 어떤 상황에 대한
//    답변인지 알려 주는 맥락일 뿐이다(사용자가 쓴 글이라 검증되지 않았고 개인 사연이 담길 수 있다).
//  - 매뉴얼 검색(ai.retrieval)과 분리해 둔다. 매뉴얼과 Q&A 는 id 공간이 겹치므로 섞지 않는다.
//  - 독립 배포를 위해 플래그로 게이트한다(마이그레이션·백필 전에는 꺼 둔다).

export interface QnaCandidate {
  id: number;
  title: string;
  category: string;
}

export const DEFAULT_QNA_TOP_K = 4;
// 코사인 거리 상한. 게시판 글이 적을 때 무관한 글이 "가장 가까운 이웃"으로 딸려 오는 것을 막는다.
// 최종 채택은 라우터 LLM 이 하므로 느슨하게 잡는다.
const MAX_COSINE_DISTANCE = 0.75;

export function qnaSearchEnabled(): boolean {
  return process.env.AI_QNA_SEARCH_ENABLED === 'true';
}

// 임베딩 입력: 제목 + 질문 + 변호사 답변. 답변이 바뀌면 해시가 달라져 재임베딩 대상이 된다.
export function buildQnaEmbedInput(title: string, content: string, answer: string): string {
  const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
  return [squash(title), squash(content), squash(answer)].filter(Boolean).join('\n');
}

// 실패(임베딩 API 장애, 컬럼 미적용 등)는 [] 로 수렴한다 — Q&A 는 보조 근거라 없어도 진단은 계속된다.
export async function retrieveQnaCandidates(
  query: string,
  opts: { limit?: number } = {},
): Promise<QnaCandidate[]> {
  if (!qnaSearchEnabled()) return [];
  const { limit = DEFAULT_QNA_TOP_K } = opts;
  try {
    const embedding = await embedText(query);
    const vector = toVectorLiteral(embedding);
    const versionPrefix = `${EMBED_VERSION}:%`;
    return await prisma.$queryRaw<QnaCandidate[]>`
      SELECT p."id", p."title", p."category"
      FROM "QnAPost" p
      JOIN "QnAAnswer" a ON a."postId" = p."id"
      WHERE p."embedding" IS NOT NULL
        AND p."embedInputHash" LIKE ${versionPrefix}
        AND (p."embedding" <=> ${vector}::vector) < ${MAX_COSINE_DISTANCE}
      ORDER BY p."embedding" <=> ${vector}::vector
      LIMIT ${limit}
    `;
  } catch (err) {
    logger.error({ event: 'ai_qna_search_failed', ...safeAiErrorFields(err, 'qna_retrieval') });
    return [];
  }
}

export interface QnaBody {
  id: number;
  title: string;
  content: string;
  answer: string;
}

// 생성 단계용 본문. 조회 시점에 답변이 삭제된 글은 빠진다.
export async function loadQnaBodies(ids: number[]): Promise<QnaBody[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.qnAPost.findMany({
    where: { id: { in: ids }, answer: { isNot: null } },
    select: { id: true, title: true, content: true, answer: { select: { content: true } } },
  });
  return rows.map((r) => ({ id: r.id, title: r.title, content: r.content, answer: r.answer?.content ?? '' }));
}

// 답변이 달리거나 수정된 직후 호출한다. 실패해도 답변 등록 자체에는 영향을 주지 않도록 호출부에서 격리한다.
// 플래그가 꺼져 있으면(= 마이그레이션 전일 수 있음) 아무것도 하지 않는다. 누락분은 백필 스크립트가 메운다.
export async function embedQnaPost(postId: number): Promise<boolean> {
  if (!qnaSearchEnabled()) return false;
  const post = await prisma.qnAPost.findUnique({
    where: { id: postId },
    select: { title: true, content: true, embedInputHash: true, answer: { select: { content: true } } },
  });
  if (!post?.answer) return false;
  const input = buildQnaEmbedInput(post.title, post.content, post.answer.content);
  const hash = embedInputHash(input);
  if (hash === post.embedInputHash) return false;
  const vector = await embedText(input);
  await prisma.$executeRaw`
    UPDATE "QnAPost"
    SET "embedding" = ${toVectorLiteral(vector)}::vector,
        "embedInputHash" = ${hash}
    WHERE "id" = ${postId}
  `;
  return true;
}

import type { PrismaClient } from '@prisma/client';
import { embedInputHash, embedText, toVectorLiteral } from '../src/services/ai.embeddings';
import { buildQnaEmbedInput } from '../src/services/ai.qna';
import type { BackfillOptions, BackfillResult, EmbedPlanItem } from './embed-manuals';

// Q&A 임베딩 backfill 코어. embed-manuals.ts 와 같은 규칙(입력+버전 해시가 다른 행만 재임베딩, 재실행 안전).
// 대상은 변호사 답변이 달린 글뿐이다.

export interface EmbeddableQnaRow {
  id: number;
  title: string;
  content: string;
  embedInputHash: string | null;
  answer: { content: string } | null;
}

export function planQnaEmbeddingBackfill(rows: EmbeddableQnaRow[]): EmbedPlanItem[] {
  return rows.flatMap((r) => {
    if (!r.answer) return [];
    const input = buildQnaEmbedInput(r.title, r.content, r.answer.content);
    const hash = embedInputHash(input);
    return hash === r.embedInputHash ? [] : [{ id: r.id, input, hash }];
  });
}

export async function backfillQnaEmbeddings(
  prisma: PrismaClient,
  { apply, log = console.log, batchSize = 50 }: BackfillOptions,
): Promise<BackfillResult> {
  const rows = await prisma.qnAPost.findMany({
    where: { answer: { isNot: null } },
    select: { id: true, title: true, content: true, embedInputHash: true, answer: { select: { content: true } } },
  });
  const pending = planQnaEmbeddingBackfill(rows);
  log(`[embed] ${pending.length}/${rows.length} answered Q&A posts need (re)embedding`);

  if (!apply || pending.length === 0) return { total: rows.length, pending: pending.length, embedded: 0 };

  let done = 0;
  for (let i = 0; i < pending.length; i += batchSize) {
    for (const item of pending.slice(i, i + batchSize)) {
      const vector = await embedText(item.input);
      await prisma.$executeRaw`
        UPDATE "QnAPost"
        SET "embedding" = ${toVectorLiteral(vector)}::vector,
            "embedInputHash" = ${item.hash}
        WHERE "id" = ${item.id}
      `;
      done += 1;
    }
    log(`[embed] Q&A ${done}/${pending.length} done`);
  }
  return { total: rows.length, pending: pending.length, embedded: done };
}

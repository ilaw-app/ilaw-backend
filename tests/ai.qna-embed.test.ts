import { describe, expect, it } from 'vitest';
import { embedInputHash } from '../src/services/ai.embeddings';
import { buildQnaEmbedInput } from '../src/services/ai.qna';
import { planQnaEmbeddingBackfill } from '../prisma/embed-qna';

const row = (over: Partial<Parameters<typeof planQnaEmbeddingBackfill>[0][number]> = {}) => ({
  id: 1, title: '알바비를 못 받았어요', content: '편의점에서  일했는데\n못 받았어요', embedInputHash: null,
  answer: { content: '노동청에 진정을 제기할 수 있습니다.' }, ...over,
});

describe('planQnaEmbeddingBackfill', () => {
  it('변호사 답변이 없는 글은 임베딩 대상이 아니다', () => {
    expect(planQnaEmbeddingBackfill([row({ answer: null })])).toEqual([]);
  });

  it('제목+질문+답변을 입력으로 쓰고, 해시가 같으면 건너뛴다', () => {
    const [item] = planQnaEmbeddingBackfill([row()]);
    expect(item.input).toBe('알바비를 못 받았어요\n편의점에서 일했는데 못 받았어요\n노동청에 진정을 제기할 수 있습니다.');
    expect(planQnaEmbeddingBackfill([row({ embedInputHash: item.hash })])).toEqual([]);
  });

  it('답변이 수정되면 다시 임베딩한다', () => {
    const stale = embedInputHash(buildQnaEmbedInput('알바비를 못 받았어요', '편의점에서 일했는데 못 받았어요', '예전 답변'));
    expect(planQnaEmbeddingBackfill([row({ embedInputHash: stale })])).toHaveLength(1);
  });
});

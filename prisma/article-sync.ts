// 매뉴얼 재적재 계획 수립.
//
// ManualArticle을 전부 지우고 다시 만들면 id가 매번 바뀐다. ArticleScrap이
// onDelete: Cascade이므로 사용자 스크랩이 통째로 사라지고, 임베딩도 전부
// 재생성해야 한다. 그래서 "카테고리 + question"이 같은 행은 id를 유지한 채
// 내용만 갱신하고, 입력에서 사라진 행만 삭제한다.
//
// question 비교는 느슨하게 한다(이모지·공백·문장부호 무시). 2026-10 노션 재export에서
// 제목 앞 "❓"가 빠지거나 물음표가 달라진 글이 있었는데, 엄격 비교면 삭제+생성이 되어
// 스크랩을 잃는다. 느슨한 키가 겹치는 글은 같은 카테고리 안에 없다(적재 전 중복 검사).

export type ExistingArticle = { id: number; categoryId: number; question: string; order?: number };
export type IncomingArticle<T> = T & { categoryId: number; question: string };

export type ArticleSyncPlan<T, E extends ExistingArticle = ExistingArticle> = {
  toCreate: Array<IncomingArticle<T>>;
  toUpdate: Array<{ id: number; article: IncomingArticle<T>; previous: E }>;
  toDeleteIds: number[];
};

// 한글·영문·숫자만 남긴다. "❓고등학교를 자퇴한 뒤…" 와 "고등학교를 자퇴한 뒤…?" 가 같은 키가 된다.
export function articleMatchKey(question: string): string {
  return question.normalize('NFC').replace(/[^\p{L}\p{N}]/gu, '');
}

function key(categoryId: number, question: string) {
  return `${categoryId} ${articleMatchKey(question)}`;
}

export function planArticleSync<T, E extends ExistingArticle = ExistingArticle>(
  existing: E[],
  incoming: Array<IncomingArticle<T>>,
): ArticleSyncPlan<T, E> {
  const existingByKey = new Map(existing.map((row) => [key(row.categoryId, row.question), row]));

  const plan: ArticleSyncPlan<T, E> = { toCreate: [], toUpdate: [], toDeleteIds: [] };
  const seen = new Set<number>();

  for (const article of incoming) {
    const previous = existingByKey.get(key(article.categoryId, article.question));
    if (previous === undefined || seen.has(previous.id)) {
      plan.toCreate.push(article);
      continue;
    }
    plan.toUpdate.push({ id: previous.id, article, previous });
    seen.add(previous.id);
  }

  plan.toDeleteIds = existing.filter((row) => !seen.has(row.id)).map((row) => row.id);
  return plan;
}

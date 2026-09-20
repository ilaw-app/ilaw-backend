-- AI 챗봇이 변호사 답변이 달린 Q&A 를 근거로 쓸 수 있도록 QnAPost 에 임베딩을 둔다.
-- ManualArticle 과 같은 형태(벡터 + 재임베딩 판정용 해시, 모두 nullable → 기존 행 보존).
-- pgvector 확장은 20260802080000_add_manual_embeddings 에서 이미 켰지만, 단독 적용에도 안전하도록 둔다.
CREATE EXTENSION IF NOT EXISTS "vector";

ALTER TABLE "QnAPost" ADD COLUMN     "embedding" vector(1536),
ADD COLUMN     "embedInputHash" TEXT;

CREATE INDEX "QnAPost_embedding_hnsw_idx"
    ON "QnAPost" USING hnsw ("embedding" vector_cosine_ops);

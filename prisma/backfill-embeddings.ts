import 'dotenv/config';
import prisma from '../src/prisma/client';
import { resolveScriptMode } from './script-safety';
import { backfillManualEmbeddings } from './embed-manuals';
import { backfillQnaEmbeddings } from './embed-qna';

// 매뉴얼 + Q&A(변호사 답변이 달린 글) 임베딩 backfill (재실행 안전/idempotent). 코어는 embed-manuals.ts / embed-qna.ts.
//
// 입력 텍스트(제목+요약+본문)+임베딩 버전 해시가 저장된 embedInputHash와 다른 행만
// (재)임베딩한다. notion-migrate 는 콘텐츠 적재 직후 같은 코어를 자동 실행하므로,
// 이 스크립트는 (1) 임베딩 모델 교체 뒤 전체 재계산 (2) 적재 시 임베딩이 누락된
// 경우의 복구 (3) 드라이런으로 미임베딩 개수 확인 용도다.
//
// 사용: npm run ai:embed                      (dry-run)
//       npm run ai:embed -- --apply --target=local
//       railway run -s Postgres -- bash -lc 'DATABASE_URL="$DATABASE_PUBLIC_URL" \
//         npx ts-node prisma/backfill-embeddings.ts --apply --target=production --confirm-production=ilaw'

async function main() {
  const mode = resolveScriptMode(process.argv.slice(2));
  console.log(`[embed] target=${mode.target}, db=${mode.databaseLabel}`);

  const result = await backfillManualEmbeddings(prisma, { apply: mode.apply });
  const qna = await backfillQnaEmbeddings(prisma, { apply: mode.apply });

  if (!mode.apply) {
    console.log('[embed] dry-run. Pass --apply to write embeddings.');
    return;
  }
  console.log(`[embed] complete. manuals=${result.embedded}, qna=${qna.embedded}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

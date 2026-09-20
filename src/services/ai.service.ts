import type OpenAI from 'openai';
import prisma from '../prisma/client';
import { retrieveCandidates, type Candidate } from './ai.retrieval';
import { buildRouterPrompt, buildGeneratePrompt, buildQnaContentBlock } from './ai.prompts';
import { loadQnaBodies, retrieveQnaCandidates } from './ai.qna';
import { detectCrisis, hotlinesFor } from './ai.crisis';
import { getAgencies } from './manual.service';
import { logDiagnosis } from './ai.metrics';
import { logger } from '../middlewares/logging';

let openai: OpenAI | undefined;

async function openAiClient(): Promise<OpenAI> {
  if (!openai) {
    const { default: OpenAIClient } = await import('openai');
    openai = new OpenAIClient({ apiKey: process.env[['OPENAI', 'API', 'KEY'].join('_')] });
  }
  return openai;
}

const DEFAULT_DAILY_REQUEST_LIMIT = 10;
const DEFAULT_BURST_REQUEST_LIMIT = 3;
const DEFAULT_OPENAI_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_COMPLETION_TOKENS = 600;
const BURST_WINDOW_MS = 60_000;

// 분당 버스트 제한은 프로세스 인메모리로 관리한다.
// NOTE(다중 인스턴스): 이 카운터는 프로세스 로컬이라 N개 인스턴스로 수평
// 확장하면 실질 한도가 N배로 샌다(일일 한도는 DB 기반이라 안전). 현재 배포는
// 단일 인스턴스(railway.toml에 numReplicas 미지정)라 문제없다. 수평 확장 시
// reserveDailyAiRequest와 동일한 원자적 DB 카운터(AiBurstUsage)로 이전할 것.
type BurstWindow = { startedAt: number; count: number };
const burstWindows = new Map<string, BurstWindow>();

// 만료된 창을 주기적으로 정리해 유휴 사용자 항목이 무한 누적되지 않게 한다.
// (기존 구현은 refund로 count가 0이 될 때만 삭제 → 유휴 항목이 영구 잔존)
let lastBurstPruneMs = 0;
function pruneExpiredBurstWindows(nowMs: number): void {
  if (nowMs - lastBurstPruneMs < BURST_WINDOW_MS) return;
  lastBurstPruneMs = nowMs;
  for (const [userId, window] of burstWindows) {
    if (nowMs - window.startedAt >= BURST_WINDOW_MS) burstWindows.delete(userId);
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function secondsUntilNextUtcDay(now: Date): number {
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.max(1, Math.ceil((tomorrow.getTime() - now.getTime()) / 1_000));
}

export function consumeAiBurstSlot(
  userId: string,
  nowMs = Date.now(),
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const limit = positiveInteger(process.env.AI_BURST_REQUEST_LIMIT, DEFAULT_BURST_REQUEST_LIMIT);
  pruneExpiredBurstWindows(nowMs);
  const current = burstWindows.get(userId);

  if (!current || nowMs - current.startedAt >= BURST_WINDOW_MS) {
    burstWindows.set(userId, { startedAt: nowMs, count: 1 });
    return { allowed: true };
  }

  if (current.count >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.startedAt + BURST_WINDOW_MS - nowMs) / 1_000)),
    };
  }

  current.count += 1;
  return { allowed: true };
}

export function refundAiBurstSlot(userId: string): void {
  const current = burstWindows.get(userId);
  if (!current) return;
  current.count = Math.max(0, current.count - 1);
  if (current.count === 0) burstWindows.delete(userId);
}

export function resetAiBurstLimits(): void {
  burstWindows.clear();
  lastBurstPruneMs = 0;
}

export async function reserveDailyAiRequest(
  userId: string,
  now = new Date(),
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  const date = utcDayStart(now);
  const limit = positiveInteger(process.env.AI_DAILY_REQUEST_LIMIT, DEFAULT_DAILY_REQUEST_LIMIT);

  const reservation = await prisma.$transaction(async tx => {
    await tx.aiDailyUsage.upsert({
      where: { userId_date: { userId, date } },
      create: { userId, date, requestCount: 0 },
      update: {},
    });
    return tx.aiDailyUsage.updateMany({
      where: { userId, date, requestCount: { lt: limit } },
      data: { requestCount: { increment: 1 } },
    });
  });

  return reservation.count === 1
    ? { allowed: true }
    : { allowed: false, retryAfterSeconds: secondsUntilNextUtcDay(now) };
}

// 사용자당 진단 이력을 최신 keep개까지만 유지한다(초과분 삭제).
export async function pruneAiChatHistory(userId: string, keep = 5): Promise<void> {
  const keepRows = await prisma.aiChatHistory.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: keep,
    select: { id: true },
  });
  if (keepRows.length < keep) return; // keep개 이하면 지울 것이 없다
  await prisma.aiChatHistory.deleteMany({
    where: { userId, id: { notIn: keepRows.map(r => r.id) } },
  });
}

export async function refundDailyAiRequest(userId: string, now = new Date()): Promise<void> {
  await prisma.aiDailyUsage.updateMany({
    where: { userId, date: utcDayStart(now), requestCount: { gt: 0 } },
    data: { requestCount: { decrement: 1 } },
  });
}

function openAiRequestOptions() {
  return { timeout: positiveInteger(process.env.AI_OPENAI_TIMEOUT_MS, DEFAULT_OPENAI_TIMEOUT_MS) };
}

function maxCompletionTokens(): number {
  return positiveInteger(process.env.AI_MAX_COMPLETION_TOKENS, DEFAULT_MAX_COMPLETION_TOKENS);
}

// 라우터(분류·매뉴얼 선택)는 정확도가 중요해 gpt-4o, 생성은 비용을 위해 gpt-4o-mini.
// 둘 다 env로 오버라이드 가능.
function routerModel(): string {
  return process.env.AI_ROUTER_MODEL || 'gpt-4o';
}
function generationModel(): string {
  return process.env.AI_GENERATION_MODEL || 'gpt-4o-mini';
}

// ── 메인 로직 ──────────────────────────────────────────────────

export type DiagnoseStatus = 'relevant' | 'unrelated' | 'needs_clarification' | 'crisis';

// suggestions 계약: manual은 Phase 1부터, agency/hotline은 Phase 2(위기대응)에서 채워진다.
export type Suggestion =
  | { type: 'manual'; id: number; label: string }
  | { type: 'qa'; id: number; label: string }
  | { type: 'agency'; id: number; label: string; contact: string; region?: string }
  | { type: 'hotline'; label: string; phone: string };

export interface DiagnoseResult {
  status: DiagnoseStatus;
  situationSummary: string;
  legalAdvice: string;
  suggestions: Suggestion[];
  followUpQuestion?: string;
  chatEnded: boolean;
}

// 무관한 메시지에 대한 고정 응답. 모델에 맡기지 않는 이유: 웹앱은 매뉴얼 범위 밖의 말을 하지 않는다는
// 정책을 코드로 보장하기 위해서다. 다만 매번 같은 문장이면 기계적으로 느껴져 여러 표현 중에서 고른다.
// 기존 계약(테스트·프론트)이 기대하는 "법률 관련 상황만" 문구는 off_topic 의 모든 표현에 유지한다.
const OFF_TOPIC_MESSAGES = [
  '저는 법률 관련 상황만 도와드릴 수 있어요. 법률적으로 어려운 상황이 생기면 언제든지 말씀해 주세요.',
  '그 이야기는 제가 잘 도와드리기 어려워요. 저는 법률 관련 상황만 안내해 드릴 수 있거든요. 혹시 곤란하거나 걱정되는 일이 있다면 편하게 들려주세요.',
  '아쉽지만 그 부분은 제가 답해 드리기 어려워요. 저는 법률 관련 상황만 도와드리고 있어요. 학교·집·일터에서 힘든 일이 있다면 언제든 이야기해 주세요.',
];
const THANKS_MESSAGES = [
  '도움이 되었다면 다행이에요. 또 궁금하거나 걱정되는 일이 생기면 언제든 찾아와 주세요.',
  '별말씀을요. 혼자 고민하지 마시고, 필요할 때 언제든 다시 이야기해 주세요.',
  '이야기 나눠 주셔서 제가 더 고마워요. 앞으로도 곤란한 일이 있으면 편하게 말씀해 주세요.',
];
const GREETING_MESSAGES = [
  '반가워요! 요즘 걱정되거나 곤란한 일이 있다면 편하게 이야기해 주세요. 제가 함께 방법을 찾아볼게요.',
  '이렇게 말 걸어 주셔서 고마워요. 혹시 마음에 걸리는 일이 있다면 천천히 들려주세요.',
  '저도 반가워요. 도움이 필요한 일이 생기면 언제든 말씀해 주세요. 혼자 고민하지 않으셔도 돼요.',
];

// 같은 사용자에게 직전과 같은 문장이 연달아 나가지 않도록, 직전 답변과 다른 것 중에서 고른다.
export function pickVariant(variants: string[], previous?: string, random: () => number = Math.random): string {
  const pool = variants.filter(v => v !== previous);
  const from = pool.length > 0 ? pool : variants;
  return from[Math.floor(random() * from.length)] ?? variants[0];
}
// 관련 상황으로 판단됐지만 근거 매뉴얼을 확정하지 못한 경우의 안전 폴백(빈 문자열 금지).
const NO_MATCH_MESSAGE =
  '말씀해 주신 상황을 살펴봤어요. 다만 정확한 안내를 위해 조금 더 구체적으로 상황을 알려주시면 더 도움이 될 것 같아요. 급하신 경우 전문 변호사 상담을 권해드려요.';
// 위기 상황에서 안내 본문이 비더라도 반드시 반환하는 안전 우선 폴백.
const CRISIS_MESSAGE =
  '지금 위험한 상황이라면 망설이지 말고 즉시 112에 신고해 주세요. 아래 긴급 연락처로 도움을 받으실 수 있어요. 혼자 감당하지 마시고 꼭 도움을 요청하세요.';

// 전화번호가 달린 suggestion(핫라인 + 지역 기관)은 답변당 총 2개까지만 노출한다.
// 위기 상황에서 핫라인이 카테고리별로 4~6개까지 붙어 번호가 쏟아지던 문제를 막는다.
const MAX_PHONE_SUGGESTIONS = 2;

// 핫라인과 기관이 모두 있으면 한 자리씩 나눠 갖고(112 등 최우선 핫라인 + 내 지역 기관),
// 한쪽이 비면 남은 자리를 다른 쪽으로 채운다.
function takePhoneSuggestions(hotlines: Suggestion[], agencies: Suggestion[]): Suggestion[] {
  const picked: Suggestion[] = [];
  if (hotlines.length) picked.push(hotlines[0]);
  if (agencies.length && picked.length < MAX_PHONE_SUGGESTIONS) picked.push(agencies[0]);
  for (const rest of [...hotlines.slice(1), ...agencies.slice(1)]) {
    if (picked.length >= MAX_PHONE_SUGGESTIONS) break;
    picked.push(rest);
  }
  return picked;
}

// 멀티턴/확장 상태(needs_clarification) 및 chatEnded=false 를 실제로 내보낼지 여부.
// 프론트 계약 변경 전까지는 꺼둔 채 배포해 기존 동작(relevant/unrelated, chatEnded=true)을 유지한다.
function multiTurnEnabled(): boolean {
  return process.env.AI_MULTITURN_ENABLED === 'true';
}

// 컨트롤러가 스레드 생성/조회 여부를 결정할 때 사용.
export function isMultiTurnEnabled(): boolean {
  return multiTurnEnabled();
}

// 위기 상태(crisis) 및 agency/hotline suggestion 노출 여부. 프론트가 새 suggestion
// 타입을 렌더링할 준비가 되면 켠다. 독립 배포를 위해 멀티턴과 분리된 플래그.
function crisisEnabled(): boolean {
  return process.env.AI_CRISIS_ENABLED === 'true';
}

interface RouterResult {
  status: 'relevant' | 'unrelated' | 'needs_clarification';
  situationSummary: string;
  selectedIds: number[];
  selectedQnaIds: number[];
  isCrisis: boolean;
  followUpQuestion: string;
  userRole: string;
  unrelatedKind: 'greeting' | 'thanks' | 'off_topic';
}

function parseRouterResponse(
  raw: string | null,
  candidateIds: Set<number>,
  qnaCandidateIds: Set<number> = new Set(),
): RouterResult | null {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = parsed as Record<string, unknown>;
    const status =
      value.status === 'relevant' || value.status === 'needs_clarification'
        ? value.status
        : 'unrelated';

    // 매뉴얼과 Q&A 는 id 공간이 겹치므로 type 별로 따로 뽑고, 각자의 후보 집합으로 환각 ID 를 거른다.
    const referenceIds = (type: 'manual' | 'qa', allowed: Set<number>): number[] =>
      Array.isArray(value.references)
        ? value.references
            .filter((reference: unknown): reference is { type: string; id: number } =>
              typeof reference === 'object'
              && reference !== null
              && (reference as Record<string, unknown>).type === type
              && typeof (reference as Record<string, unknown>).id === 'number')
            .map(reference => reference.id)
            // 후보 밖의 환각 ID 방지: 실제 추천 후보에 포함된 것만 채택
            .filter(id => allowed.has(id))
        : [];
    const selectedIds = referenceIds('manual', candidateIds);
    const selectedQnaIds = referenceIds('qa', qnaCandidateIds);

    return {
      status,
      situationSummary: typeof value.situationSummary === 'string' ? value.situationSummary : '',
      selectedIds,
      selectedQnaIds,
      isCrisis: value.isCrisis === true,
      followUpQuestion: typeof value.followUpQuestion === 'string' ? value.followUpQuestion : '',
      userRole: typeof value.userRole === 'string' ? value.userRole : '',
      unrelatedKind: value.unrelatedKind === 'greeting' || value.unrelatedKind === 'thanks'
        ? value.unrelatedKind
        : 'off_topic',
    };
  } catch {
    return null;
  }
}

export async function diagnose(
  message: string,
  nickname?: string,
  history: { question: string; legalAdvice: string }[] = [],
  opts: { region?: string; priorStatus?: string; userId?: string; conversationId?: string } = {},
): Promise<DiagnoseResult> {
  const startedAt = Date.now();
  const userLabel = nickname ? `${nickname}님` : '사용자';
  const multiTurn = multiTurnEnabled();

  // ── 관측 지표 누적 + 종료 시 한 줄 로깅 ──
  let retrieveMs = 0, step1Ms = 0, step2Ms = 0;
  let retrievedIds: number[] = [];
  let selectedForLog: number[] = [];
  let step1Tokens: number | undefined;
  let step2Tokens: number | undefined;
  let userRoleForLog: string | undefined;

  const finish = (result: DiagnoseResult, crisis = false): DiagnoseResult => {
    logDiagnosis({
      userId: opts.userId,
      conversationId: opts.conversationId,
      status: result.status,
      userRole: userRoleForLog,
      crisis,
      retrievedCount: retrievedIds.length,
      retrievedIds,
      selectedIds: selectedForLog,
      step1Tokens,
      step2Tokens,
      latencyMs: { retrieve: retrieveMs, step1: step1Ms, step2: step2Ms, total: Date.now() - startedAt },
    });
    return result;
  };

  // ── 검색: 전 카테고리에서 관련 후보 압축(전체목록 주입 폐기) ──
  const tRetrieve = Date.now();
  // 멀티턴의 후속 발화("어디에 신고해요?", "잘릴까봐 무서워요")는 그것만으로는 주제를 알 수 없어
  // 다른 유형의 매뉴얼이 걸린다. 같은 대화의 직전 질문을 검색 질의에 붙여 주제를 이어 간다.
  // (단발 모드의 history 는 대화 단위가 아니라 사용자의 최근 질문이라 섞으면 안 된다.)
  const previousQuestion = multiTurn ? history[history.length - 1]?.question : undefined;
  const retrievalQuery = previousQuestion ? `${previousQuestion} ${message}` : message;
  // Q&A(변호사 답변) 후보는 플래그가 꺼져 있거나 실패하면 [] — 매뉴얼 경로에 영향을 주지 않는다.
  const [candidates, qnaCandidates] = await Promise.all([
    retrieveCandidates(retrievalQuery),
    retrieveQnaCandidates(retrievalQuery),
  ]);
  const qnaCandidateIds = new Set(qnaCandidates.map(q => q.id));
  retrieveMs = Date.now() - tRetrieve;
  retrievedIds = candidates.map(c => c.id);
  const candidateIds = new Set(candidates.map(c => c.id));

  const historyMessages = history.flatMap(h => [
    { role: 'user' as const, content: h.question },
    { role: 'assistant' as const, content: h.legalAdvice },
  ]);

  // 직전 턴이 되묻기였다면, 이번 메시지는 그에 대한 답변임을 라우터에 알린다.
  if (opts.priorStatus === 'needs_clarification') {
    historyMessages.push({
      role: 'assistant' as const,
      content: '(직전에 사용자에게 상황을 더 구체적으로 물었습니다. 아래 답변을 반영해 다시 진단하세요.)',
    });
  }

  // ── GPT 1차(라우터): 분류 + 후보 중 매뉴얼 선택 ──
  const tStep1 = Date.now();
  const step1Res = await (await openAiClient()).chat.completions.create({
    model: routerModel(),
    max_completion_tokens: maxCompletionTokens(),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildRouterPrompt(candidates, userLabel, { allowClarification: multiTurn, qnaCandidates }) },
      ...historyMessages,
      { role: 'user', content: message },
    ],
  }, openAiRequestOptions());
  step1Ms = Date.now() - tStep1;
  step1Tokens = step1Res.usage?.total_tokens;

  const router = parseRouterResponse(step1Res.choices[0].message.content, candidateIds, qnaCandidateIds);
  if (router) userRoleForLog = router.userRole || undefined;

  // unrelated 턴은 이력에 저장되지 않으므로 previous 는 대개 비지만, 저장 정책이 바뀌어도 반복을 피한다.
  const previousAdvice = history[history.length - 1]?.legalAdvice;

  if (!router) {
    logger.error({ event: 'ai_router_parse_failed' });
    return finish({
      status: 'unrelated',
      situationSummary: '',
      legalAdvice: pickVariant(OFF_TOPIC_MESSAGES, previousAdvice),
      suggestions: [],
      chatEnded: true,
    });
  }

  if (router.status === 'unrelated') {
    return finish({
      status: 'unrelated',
      situationSummary: '',
      legalAdvice: pickVariant(
        { greeting: GREETING_MESSAGES, thanks: THANKS_MESSAGES, off_topic: OFF_TOPIC_MESSAGES }[router.unrelatedKind],
        previousAdvice,
      ),
      suggestions: [],
      // 멀티턴에서는 인사 뒤에 바로 상황을 이어 말할 수 있어야 하므로 대화를 닫지 않는다.
      chatEnded: !multiTurn,
    });
  }

  // 되묻기: 멀티턴이 켜졌고 질문이 있을 때만 별도 상태로 반환한다.
  if (router.status === 'needs_clarification' && multiTurn && router.followUpQuestion) {
    return finish({
      status: 'needs_clarification',
      situationSummary: router.situationSummary,
      legalAdvice: '',
      suggestions: [],
      followUpQuestion: router.followUpQuestion,
      chatEnded: false,
    });
  }

  // ── relevant 처리 ──
  // 라우터가 유형·관점이 맞는 매뉴얼이 없다고 판단하면(빈 배열) 억지로 채우지 않는다.
  // 틀린 매뉴얼을 미는 것보다, 매뉴얼 없이 안전 안내 + 핫라인/기관을 주는 편이 안전하다.
  const selectedIds = router.selectedIds;
  selectedForLog = selectedIds;

  const selectedCandidates = selectedIds
    .map(id => candidates.find(c => c.id === id))
    .filter((c): c is Candidate => c !== undefined);
  const selectedSlugs = [...new Set(selectedCandidates.map(c => c.categorySlug))];

  // 위기 판정: 룰(키워드) OR 라우터 LLM 신호(이중 판정). 플래그로 게이트.
  const crisis = crisisEnabled()
    && (router.isCrisis || detectCrisis(message, selectedSlugs).level === 'high');

  const fullArticles = selectedIds.length > 0
    ? await prisma.manualArticle.findMany({
        where: { id: { in: selectedIds } },
        select: { id: true, question: true, content: true },
      })
    : [];

  // ── GPT 2차(생성): 선택 매뉴얼 전문 근거 RAG 안내 ──
  const qnaBodies = await loadQnaBodies(router.selectedQnaIds);
  const contentBlocks = [
    ...fullArticles.map(a => `[매뉴얼] ${a.question}\n${a.content}`),
    ...qnaBodies.map(buildQnaContentBlock),
  ].join('\n\n---\n\n');

  let legalAdvice = '';
  if (contentBlocks) {
    const tStep2 = Date.now();
    const step2Res = await (await openAiClient()).chat.completions.create({
      model: generationModel(),
      max_completion_tokens: maxCompletionTokens(),
      messages: [
        { role: 'system', content: buildGeneratePrompt(contentBlocks, userLabel, { crisis, multiTurn }) },
        ...historyMessages,
        { role: 'user', content: message },
      ],
    }, openAiRequestOptions());
    step2Ms = Date.now() - tStep2;
    step2Tokens = step2Res.usage?.total_tokens;
    legalAdvice = step2Res.choices[0].message.content?.trim() ?? '';
  }

  // 폴백: 어떤 이유로든 안내가 비면 고정 문구로 대체(빈 문자열 금지).
  if (!legalAdvice) legalAdvice = crisis ? CRISIS_MESSAGE : NO_MATCH_MESSAGE;

  // ── suggestions 조립 ──
  // 기관(agency) 연락처는 고위험 여부와 무관하게 항상 노출한다.
  // 긴급 핫라인(hotline)은 위기 상황에서만 최상단에 붙인다.
  // Q&A 는 매뉴얼 뒤에 붙인다(검증된 공식 콘텐츠가 먼저). 프론트는 /qna/:id 로 연결한다.
  const manualSuggestions: Suggestion[] = [
    ...selectedCandidates.map((c): Suggestion => ({ type: 'manual', id: c.id, label: c.question })),
    ...qnaBodies.map((q): Suggestion => ({ type: 'qa', id: q.id, label: q.title })),
  ];

  const agencyRows = (await Promise.all(selectedSlugs.map(slug => getAgencies(slug)))).flat();
  // 사용자 지역과 일치하는 기관을 앞으로.
  if (opts.region) {
    agencyRows.sort((a, b) =>
      (b.region === opts.region ? 1 : 0) - (a.region === opts.region ? 1 : 0));
  }
  const agencySuggestions: Suggestion[] = agencyRows.map(a => ({
    type: 'agency', id: a.id, label: a.name, contact: a.contact,
    ...(a.region ? { region: a.region } : {}),
  }));

  let suggestions: Suggestion[];
  if (crisis) {
    const hotlineSuggestions: Suggestion[] = hotlinesFor(selectedSlugs).map(h => ({
      type: 'hotline', label: h.label, phone: h.phone,
    }));
    suggestions = [...takePhoneSuggestions(hotlineSuggestions, agencySuggestions), ...manualSuggestions];
  } else {
    suggestions = [...manualSuggestions, ...takePhoneSuggestions([], agencySuggestions)];
  }

  return finish({
    status: crisis ? 'crisis' : 'relevant',
    situationSummary: router.situationSummary,
    legalAdvice,
    suggestions,
    chatEnded: multiTurn ? false : true,
  }, crisis);
}

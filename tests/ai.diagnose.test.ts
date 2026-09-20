import { beforeEach, describe, expect, it, vi } from 'vitest';

const openAiCreateMock = vi.hoisted(() => vi.fn());
const retrieveCandidatesMock = vi.hoisted(() => vi.fn());
const retrieveQnaCandidatesMock = vi.hoisted(() => vi.fn());
const loadQnaBodiesMock = vi.hoisted(() => vi.fn());
const prismaMock = vi.hoisted(() => ({
  manualArticle: { findMany: vi.fn() },
  agency: { findMany: vi.fn() },
}));

vi.mock('openai', () => ({
  default: vi.fn(function OpenAIMock() {
    return { chat: { completions: { create: openAiCreateMock } } };
  }),
}));
vi.mock('../src/prisma/client', () => ({ default: prismaMock }));
vi.mock('../src/services/ai.retrieval', () => ({ retrieveCandidates: retrieveCandidatesMock }));
vi.mock('../src/services/ai.qna', () => ({
  retrieveQnaCandidates: retrieveQnaCandidatesMock,
  loadQnaBodies: loadQnaBodiesMock,
}));

import { diagnose, pickVariant } from '../src/services/ai.service';

function routerResponse(obj: unknown) {
  return { choices: [{ message: { content: JSON.stringify(obj) } }] };
}
function textResponse(text: string) {
  return { choices: [{ message: { content: text } }] };
}

const LABOR_CANDIDATE = {
  id: 1,
  question: '임금 체불 신고 방법',
  summary: '임금을 못 받았을 때',
  categorySlug: 'labor',
  categoryName: '노동',
  score: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AI_MULTITURN_ENABLED;
  delete process.env.AI_CRISIS_ENABLED;
  retrieveCandidatesMock.mockResolvedValue([]);
  retrieveQnaCandidatesMock.mockResolvedValue([]);
  loadQnaBodiesMock.mockResolvedValue([]);
  prismaMock.manualArticle.findMany.mockResolvedValue([]);
  prismaMock.agency.findMany.mockResolvedValue([]);
});

describe('diagnose 상태머신', () => {
  it('unrelated: 고정 안내를 반환하고 생성 단계를 호출하지 않는다', async () => {
    openAiCreateMock.mockResolvedValueOnce(routerResponse({ status: 'unrelated' }));

    const result = await diagnose('안녕하세요');

    expect(result.status).toBe('unrelated');
    expect(result.legalAdvice).toContain('법률 관련 상황만');
    expect(result.suggestions).toEqual([]);
    expect(result.chatEnded).toBe(true);
    expect(openAiCreateMock).toHaveBeenCalledOnce(); // 라우터만
  });

  it('unrelated(greeting): 거절 문구 대신 따뜻한 인사로 답한다', async () => {
    openAiCreateMock.mockResolvedValueOnce(routerResponse({ status: 'unrelated', unrelatedKind: 'greeting' }));

    const result = await diagnose('안녕하세요');

    expect(result.status).toBe('unrelated');
    expect(result.legalAdvice).not.toContain('법률 관련 상황만');
    expect(result.legalAdvice).toMatch(/이야기해 주세요|들려주세요|말씀해 주세요/);
    expect(openAiCreateMock).toHaveBeenCalledOnce();
  });

  it('router JSON 파싱 실패 시 안전 폴백(unrelated)으로 처리한다', async () => {
    openAiCreateMock.mockResolvedValueOnce(textResponse('완전히 JSON이 아님'));

    const result = await diagnose('임금 체불 당했어요');

    expect(result.status).toBe('unrelated');
    expect(result.legalAdvice).toContain('법률 관련 상황만');
    expect(openAiCreateMock).toHaveBeenCalledOnce();
  });

  it('relevant: 선택 매뉴얼 기반 안내와 suggestion을 반환한다', async () => {
    retrieveCandidatesMock.mockResolvedValue([LABOR_CANDIDATE]);
    openAiCreateMock
      .mockResolvedValueOnce(
        routerResponse({
          status: 'relevant',
          situationSummary: '홍길동님은 임금을 받지 못했습니다.',
          references: [{ type: 'manual', id: 1 }],
          isCrisis: false,
        }),
      )
      .mockResolvedValueOnce(textResponse('정말 힘드셨겠어요. 고용노동부에 진정을 넣을 수 있어요.'));
    prismaMock.manualArticle.findMany.mockResolvedValue([
      { id: 1, question: '임금 체불 신고 방법', content: '진정 절차...' },
    ]);

    const result = await diagnose('임금을 못 받았어요', '홍길동');

    expect(result.status).toBe('relevant');
    expect(result.situationSummary).toContain('홍길동님은');
    expect(result.legalAdvice).toContain('고용노동부');
    expect(result.suggestions).toEqual([{ type: 'manual', id: 1, label: '임금 체불 신고 방법' }]);
    expect(result.chatEnded).toBe(true);
    expect(openAiCreateMock).toHaveBeenCalledTimes(2);
  });

  it('라우터가 하나도 못 고르면 매뉴얼을 억지로 채우지 않는다', async () => {
    retrieveCandidatesMock.mockResolvedValue([LABOR_CANDIDATE]);
    openAiCreateMock.mockResolvedValueOnce(
      routerResponse({ status: 'relevant', situationSummary: 'x', references: [] }),
    );

    const result = await diagnose('상황 설명', '홍길동');

    // 틀린 매뉴얼을 밀지 않고, 매뉴얼 없이 안전 폴백 문구를 반환한다.
    expect(result.status).toBe('relevant');
    expect(result.suggestions.some((s) => s.type === 'manual')).toBe(false);
    expect(result.legalAdvice).toContain('조금 더 구체적으로');
    expect(openAiCreateMock).toHaveBeenCalledOnce(); // 생성(step2) 스킵
  });

  it('후보 밖 환각 ID는 제외하고, 안내가 비면 고정 폴백 문구로 대체한다', async () => {
    retrieveCandidatesMock.mockResolvedValue([LABOR_CANDIDATE]);
    openAiCreateMock.mockResolvedValueOnce(
      routerResponse({ status: 'relevant', situationSummary: 'x', references: [{ type: 'manual', id: 99 }] }),
    );
    // 폴백 채택 id=1이지만 content 조회가 비어 생성 스킵 → 폴백 문구
    prismaMock.manualArticle.findMany.mockResolvedValue([]);

    const result = await diagnose('상황', '홍길동');

    expect(result.status).toBe('relevant');
    expect(result.suggestions.map((s) => (s.type === 'manual' ? s.id : -1))).not.toContain(99);
    expect(result.legalAdvice).toContain('조금 더 구체적으로');
    expect(openAiCreateMock).toHaveBeenCalledOnce(); // 생성 스킵
  });

  describe('멀티턴 활성화(AI_MULTITURN_ENABLED=true)', () => {
    beforeEach(() => {
      process.env.AI_MULTITURN_ENABLED = 'true';
    });

    it('needs_clarification: 되묻는 질문과 chatEnded=false를 반환한다', async () => {
      openAiCreateMock.mockResolvedValueOnce(
        routerResponse({
          status: 'needs_clarification',
          situationSummary: '',
          references: [],
          followUpQuestion: '어떤 상황인지 조금 더 자세히 알려주실 수 있을까요?',
        }),
      );

      const result = await diagnose('도와주세요');

      expect(result.status).toBe('needs_clarification');
      expect(result.followUpQuestion).toContain('자세히');
      expect(result.chatEnded).toBe(false);
      expect(openAiCreateMock).toHaveBeenCalledOnce(); // 생성 스킵
    });

    it('crisis: isCrisis=true면 상태를 crisis로 승격한다', async () => {
      process.env.AI_CRISIS_ENABLED = 'true';
      retrieveCandidatesMock.mockResolvedValue([
        { id: 7, question: '아동학대 신고', summary: null, categorySlug: 'child-abuse', categoryName: '아동학대', score: 3 },
      ]);
      openAiCreateMock
        .mockResolvedValueOnce(
          routerResponse({
            status: 'relevant',
            situationSummary: 'x',
            references: [{ type: 'manual', id: 7 }],
            isCrisis: true,
          }),
        )
        .mockResolvedValueOnce(textResponse('안전이 가장 중요해요. 즉시 112에 신고하세요.'));
      prismaMock.manualArticle.findMany.mockResolvedValue([
        { id: 7, question: '아동학대 신고', content: '신고 절차...' },
      ]);

      const result = await diagnose('아이가 맞고 있어요');

      expect(result.status).toBe('crisis');
      expect(result.chatEnded).toBe(false);
    });
  });

  it('멀티턴 비활성 시 needs_clarification/crisis 대신 relevant로 처리한다', async () => {
    // 멀티턴 off에서 라우터에 clarification 옵션이 없으므로 relevant로 응답
    retrieveCandidatesMock.mockResolvedValue([LABOR_CANDIDATE]);
    openAiCreateMock
      .mockResolvedValueOnce(
        routerResponse({ status: 'relevant', situationSummary: 'x', references: [{ type: 'manual', id: 1 }], isCrisis: true }),
      )
      .mockResolvedValueOnce(textResponse('안내'));
    prismaMock.manualArticle.findMany.mockResolvedValue([{ id: 1, question: '임금 체불 신고 방법', content: 'c' }]);

    const result = await diagnose('상황', '홍길동');

    // isCrisis=true여도 멀티턴 off면 crisis 승격/ chatEnded=false 하지 않음
    expect(result.status).toBe('relevant');
    expect(result.chatEnded).toBe(true);
  });
});

describe('diagnose Q&A 근거', () => {
  const QNA_CANDIDATE = { id: 1, title: '알바비를 못 받았어요', category: '노동' };
  const QNA_BODY = { id: 1, title: '알바비를 못 받았어요', content: '편의점에서 일했는데…', answer: '노동청에 진정을 제기할 수 있습니다.' };

  it('라우터가 고른 Q&A를 생성 근거와 qa suggestion으로 쓴다(매뉴얼과 id가 겹쳐도 구분)', async () => {
    retrieveCandidatesMock.mockResolvedValue([LABOR_CANDIDATE]); // manual id=1
    retrieveQnaCandidatesMock.mockResolvedValue([QNA_CANDIDATE]); // qa id=1
    loadQnaBodiesMock.mockResolvedValue([QNA_BODY]);
    openAiCreateMock
      .mockResolvedValueOnce(routerResponse({
        status: 'relevant', userRole: '피해자', situationSummary: '사용자는 알바비를 받지 못했습니다.',
        references: [{ type: 'qa', id: 1 }],
      }))
      .mockResolvedValueOnce(textResponse('노동청에 진정을 제기할 수 있어요.'));

    const result = await diagnose('알바비를 못 받았어요');

    expect(loadQnaBodiesMock).toHaveBeenCalledWith([1]);
    expect(prismaMock.manualArticle.findMany).not.toHaveBeenCalled(); // type=qa 는 매뉴얼 선택이 아니다
    expect(result.suggestions).toEqual([{ type: 'qa', id: 1, label: QNA_BODY.title }]);

    const routerSystem = openAiCreateMock.mock.calls[0][0].messages[0].content as string;
    expect(routerSystem).toContain('[QNA id=1]');
    const generateSystem = openAiCreateMock.mock.calls[1][0].messages[0].content as string;
    expect(generateSystem).toContain('[변호사 답변 Q&A]');
    expect(generateSystem).toContain(QNA_BODY.answer);
  });

  it('후보에 없는 Q&A id는 버린다', async () => {
    retrieveQnaCandidatesMock.mockResolvedValue([QNA_CANDIDATE]);
    openAiCreateMock.mockResolvedValueOnce(routerResponse({
      status: 'relevant', userRole: '피해자', situationSummary: '사용자는 …', references: [{ type: 'qa', id: 999 }],
    }));

    const result = await diagnose('알바비를 못 받았어요');

    expect(loadQnaBodiesMock).toHaveBeenCalledWith([]);
    expect(result.suggestions).toEqual([]);
  });

  it('Q&A 후보가 없으면 라우터 프롬프트에 Q&A 섹션이 없다', async () => {
    openAiCreateMock.mockResolvedValueOnce(routerResponse({ status: 'unrelated' }));
    await diagnose('안녕하세요');
    expect(openAiCreateMock.mock.calls[0][0].messages[0].content).not.toContain('후보 Q&A 목록');
  });
});

describe('pickVariant', () => {
  it('직전 답변과 같은 문장은 고르지 않는다', () => {
    const variants = ['가', '나', '다'];
    for (let i = 0; i < 20; i += 1) expect(pickVariant(variants, '가')).not.toBe('가');
  });

  it('후보가 하나뿐이면 그대로 반환한다', () => {
    expect(pickVariant(['가'], '가')).toBe('가');
  });
});

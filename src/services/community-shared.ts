// 신고 누적으로 삭제된 댓글만 목록에 자리를 남긴다. 답글이 달린 스레드에서
// 부모가 통째로 사라지면 대화 맥락이 끊기기 때문에 안내문으로 자리를 지킨다.
export const REMOVED_COMMENT_MASK = '신고가 누적되어 삭제된 댓글입니다.';

// 목록에서 통째로 감추는 댓글 상태. 욕설 자동감지(hidden)와 작성자 삭제(deleted)는
// 안내문조차 남기지 않는다. 화면에 보이지 않으므로 댓글 수에서도 똑같이 뺀다.
export const DROPPED_COMMENT_STATUSES = ['hidden', 'deleted'];

export const HIDDEN_POST_STATUSES = ['hidden', 'removed', 'deleted'];
export const ANONYMOUS_POST_AUTHOR = '익명';

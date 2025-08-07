// 한글 주석: LangSmith 연동을 위한 관찰(Observability) 헬퍼
// - LANGSMITH_TRACING=true 일 때 OpenAI 클라이언트를 래핑하여 자동 추적
// - 기존 코드 변경 최소화: OpenAI 호출 지점은 그대로, 클라이언트만 교체

import { wrapOpenAI } from 'langsmith/wrappers'

/**
 * LangSmith 추적 활성화 시 OpenAI 클라이언트를 감싸서 반환합니다.
 * 환경 변수:
 * - LANGSMITH_TRACING=true|1
 * - LANGSMITH_API_KEY=... (필수)
 * - LANGSMITH_PROJECT=... (선택)
 */
export function maybeWrapOpenAIForTracing<T>(client: T): T {
  const enabled = String(process.env.LANGSMITH_TRACING || '').toLowerCase()
  const isEnabled = enabled === 'true' || enabled === '1'
  if (!isEnabled) return client

  try {
    // 한글 주석: 래핑 후 반환(스트리밍/Responses API 모두 지원)
    return wrapOpenAI(client as any) as unknown as T
  } catch (e) {
    // 한글 주석: 문제가 있어도 운영에 영향 없도록 원본 클라이언트 반환
    console.warn('⚠️ LangSmith wrapOpenAI 실패. 원본 클라이언트 사용:', e)
    return client
  }
}



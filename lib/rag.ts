// 한글 주석: RAG 컨텍스트 구성 및 매칭 로직 캡슐화
import { encode as encodeTokens } from 'gpt-tokenizer'
import { getServerSupabaseClient } from '@/lib/supabase-server'
import { getConfig } from '@/lib/config'
import { codeBlock, oneLine } from 'common-tags'

export type PageSection = {
  id?: number
  path?: string
  heading?: string
  similarity?: number
  content?: string
}

export type UsedSection = {
  id: number
  path: string
  heading: string
  similarity: number
  content_length: number
  token_count: number
}

export async function matchSectionsForQuery(embedding: number[]) {
  const supabase = getServerSupabaseClient()
  const { data, error } = await supabase.rpc('match_page_sections', {
    embedding,
    match_threshold: 0.5,
    match_count: 10,
    min_content_length: 30,
  })
  if (error) throw error
  return (data ?? []) as PageSection[]
}

export function buildContextFromSections(sections: PageSection[]) {
  let tokenCount = 0
  let contextText = ''
  const usedSections: UsedSection[] = []

  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]
    if (!s || !s.content) continue

    const sectionTokenCount = encodeTokens(s.content).length
    if (tokenCount + sectionTokenCount >= 1500) break

    tokenCount += sectionTokenCount
    contextText += `${s.content.trim()}\n---\n`
    usedSections.push({
      id: s.id ?? i,
      path: s.path ?? 'unknown',
      heading: s.heading ?? '제목 없음',
      similarity: s.similarity ?? 0,
      content_length: s.content.length,
      token_count: sectionTokenCount,
    })
  }

  return { contextText, usedSections }
}

export function buildKoreanLegalPrompt(contextText: string, question: string) {
  const safeContextText = contextText || ''
  const safeQuestion = question || ''
  return codeBlock`
    ${oneLine`
      당신은 대한민국 법률 '정보'를 안내하는 따뜻하고 공감하는 상담사입니다. 아래 '법적 정보' 범위 내에서만 사실에 근거해,
      쉬운 한국어와 존댓말로 답하세요. 문서에 없는 내용은 절대 추정하거나 만들어내지 않습니다.
    `}

    답변 원칙:
    - 간결하게 답변하세요.
    - 어려운 용어는 쉬운 표현으로 풀어 설명
    - 전문 법률 자문이 필요한 지점은 명확히 표시하고, 변호사 상담을 권유
    - 답변 마지막에 짧은 후속 질문 1개를 포함해 대화를 자연스럽게 이어가기
    - 사용자가 원할 경우 변호사 상담 연결을 정중히 제안하고, 선호 연락 방법(전화/이메일)과 가능 시간을 물어보기
    - 사용자 말투를 가볍게 반영하되, 기본은 존댓말로 공손하게 응답하기

    법적 정보:
    ${safeContextText}

    질문: """
    ${safeQuestion}
    """

    만약 제공된 법적 정보만으로 충분히 답하기 어렵다면 다음처럼 말하세요:
    "제공된 정보로는 정확한 답변을 드리기 어렵습니다. 전문 변호사와 상담하시기를 권합니다."
  `
}



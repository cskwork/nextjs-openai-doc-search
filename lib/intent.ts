// 한글 주석: 인텐트 분류 로직 모듈화
import { oneLine } from 'common-tags'
import { getOpenAIClient } from '@/lib/openai-client'
import { getConfig } from '@/lib/config'
import { formatOpenAIError } from '@/lib/openai-client'

export type ClassifiedIntent = {
  intent: string
  confidence: number
}

export async function classifyIntentKorean(text: string): Promise<ClassifiedIntent> {
  const openai = getOpenAIClient()
  const { models } = getConfig()

  const tryParseIntentJson = (raw: string) => {
    try {
      return JSON.parse(raw)
    } catch (_) {
      const m = raw.match(/\{[\s\S]*\}/)
      if (m) {
        return JSON.parse(m[0])
      }
      return null
    }
  }

  let intent = 'legal_question'
  let confidence = 0

  try {
    const instructions = oneLine`
      당신은 한국어 법률 상담 도메인의 인텐트 분류기입니다. 사용자의 입력을 다음 중 하나로 분류하세요:
      "greeting" | "legal_question" | "smalltalk" | "non_legal" | "other".
      반드시 엄격한 JSON으로만 응답하세요. 형식: {"intent":"...","confidence":0.0~1.0}
      설명, 추가 텍스트, 코드블록 없이 JSON만 반환하세요.`
    const resp = await openai.responses.create({
      model: models.intent,
      instructions,
      input: text,
    })
    const raw = (resp as any).output_text ?? ''
    const parsed = tryParseIntentJson(raw)
    if (parsed?.intent) intent = String(parsed.intent)
    if (typeof parsed?.confidence === 'number') confidence = parsed.confidence
  } catch (e) {
    // 한글 주석: 폴백 시도
    try {
      const fallback = oneLine`
        당신은 한국어 법률 상담 도메인의 인텐트 분류기입니다. 사용자의 입력을 다음 중 하나로 분류하세요:
        "greeting" | "legal_question" | "smalltalk" | "non_legal" | "other".
        반드시 엄격한 JSON으로만 응답하세요. 형식: {"intent":"...","confidence":0.0~1.0}
        설명, 추가 텍스트, 코드블록 없이 JSON만 반환하세요.`
      const fbResp = await openai.responses.create({
        model: models.intent,
        instructions: fallback,
        input: text,
      })
      const fbRaw = (fbResp as any).output_text ?? ''
      const fbParsed = tryParseIntentJson(fbRaw)
      if (fbParsed?.intent) intent = String(fbParsed.intent)
      if (typeof fbParsed?.confidence === 'number') confidence = fbParsed.confidence
    } catch (e2) {
      console.warn('⚠️ 인텐트 분류 최종 실패, 기본값 사용:', formatOpenAIError(e2))
    }
  }

  return { intent, confidence }
}



import type { NextApiRequest, NextApiResponse } from 'next'
import { oneLine } from 'common-tags'
import { ApplicationError, UserError } from '@/lib/errors'
import { getConfig } from '@/lib/config'
import { getOpenAIClient, formatOpenAIError } from '@/lib/openai-client'
import { getServerSupabaseClient } from '@/lib/supabase-server'
import { writePlainTextHeaders, writeCitations, writeWithBackpressure, sendTextWithCitations } from '@/lib/http'
import { classifyIntentKorean } from '@/lib/intent'
import { matchSectionsForQuery, buildContextFromSections, buildKoreanLegalPrompt } from '@/lib/rag'

// 공용 타입
// 한글 주석: 로컬 타입 제거(공용 모듈의 타입 사용)

// 응답 헬퍼: 공통 헤더 설정
// 헤더/쓰기 유틸은 '@/lib/http' 사용

// 응답 헬퍼: 인용 주석 전송
// 인용 유틸은 '@/lib/http' 사용

// 응답 헬퍼: 백프레셔 안전 쓰기
// 백프레셔 유틸은 '@/lib/http' 사용

// 응답 헬퍼: 단일 텍스트 응답 전송
// 텍스트 전송 유틸은 '@/lib/http' 사용

// 유틸: 불리언 파싱 ("true"/true 허용)
// 불리언 파싱 유틸은 '@/lib/http' 사용

// 유틸: 서버용 Supabase 클라이언트
// Supabase 클라이언트는 '@/lib/supabase-server' 사용

// 한글 주석: 빌드 시 환경변수 의존을 피하기 위해 런타임에 초기화

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    // 한글 주석: 요청 및 환경 체크
    console.log('🚀 Vector search API 호출')
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' })
    }

    // 한글 주석: 구성 로딩(유효성은 getConfig에서 보장) 및 OpenAI 클라이언트 초기화
    const { models } = getConfig()
    const openai = getOpenAIClient()

    const requestData = req.body
    if (!requestData) {
      throw new UserError('Missing request data')
    }

    const { prompt: query } = requestData
    // 한글 주석: 대화 히스토리 및 최대 길이(개수) 옵션 처리
    const history = Array.isArray(requestData?.history) ? (requestData.history as Array<{ role: string; content: string }>) : []
    const historyLimitEnv = Number(process.env.CHAT_HISTORY_LIMIT || process.env.NEXT_PUBLIC_CHAT_HISTORY_LIMIT || 3)
    const historyLimit = Number.isFinite(historyLimitEnv) && historyLimitEnv > 0 ? historyLimitEnv : 3
    const historyMax = Number.isFinite(Number(requestData?.historyLimit)) && Number(requestData?.historyLimit) > 0
      ? Math.min(Number(requestData.historyLimit), 10)
      : historyLimit
    const trimmedHistory = history.slice(-historyMax)
    // 한글 주석: 기본을 스트리밍으로 변경 (클라이언트가 명시적으로 false를 보낼 때만 비스트리밍)
    const wantsStream = requestData?.stream === false ? false : true

    if (!query) {
      throw new UserError('Missing query in request data')
    }

    const supabaseClient = getServerSupabaseClient()

    // Moderate the content to comply with OpenAI T&C
    const sanitizedQuery = query.trim()
    const moderationResponse = await openai.moderations.create({
      model: models.moderation,
      input: sanitizedQuery,
    })

    // Vercel 환경에서 moderationResponse.results가 undefined일 수 있음
    if (
      !moderationResponse.results ||
      !Array.isArray(moderationResponse.results) ||
      moderationResponse.results.length === 0
    ) {
      throw new ApplicationError('Invalid moderation response from OpenAI')
    }

    const [results] = moderationResponse.results

    if (results.flagged) {
      throw new UserError('Flagged content', {
        flagged: true,
        categories: results.categories,
      })
    }

    // LLM 기반 인텐트 분류
    const { intent: classifiedIntent, confidence: classifiedConfidence } = await classifyIntentKorean(
      sanitizedQuery
    )

    // 인사/스몰톡/비법률 대응은 RAG 생략 후 즉시 응답
    if (classifiedIntent === 'greeting' || classifiedIntent === 'smalltalk') {
      const greetingAnswer = [
        '안녕하세요! 법무 상담 AI 어시스턴트입니다. 어떤 법적 문의를 도와드릴까요?\n',
        '- 예: 계약서 작성 시 주의사항은 무엇인가요?\n',
        '- 예: 직장에서 부당한 대우를 받았을 때 어떻게 해야 하나요?\n',
        '- 예: 임대차 계약 만료 후 보증금 반환 절차가 궁금해요.\n',
        '\n필요하시다면 변호사 상담 연결도 도와드릴게요. 선호하시는 연락 방법(전화/이메일)과 가능하신 시간을 알려주실 수 있을까요?'
      ].join('\n')
      sendTextWithCitations(res, greetingAnswer, [], sanitizedQuery)
      return
    }

    if (classifiedIntent === 'non_legal' || classifiedIntent === 'other') {
      // 한글 주석: 비법률/기타 주제의 경우에도 간단한 일반 정보 응답을 제공하고 상담 연결로 부드럽게 유도
      try {
        const nonLegalSystem = oneLine`
          당신은 따뜻하고 공감하는 한국어 상담사입니다. 법률 '외' 주제에 대해 사용자의 질문에 일반 정보 수준으로만 간단히(2~3문장) 답합니다.
          전문적 조언이나 확정적 단정은 피하고, 안전한 범위에서 설명하세요. 말투는 사용자 입력의 톤을 가볍게 반영하되 기본은 존댓말입니다.
          오직 간결한 답변 텍스트만 반환하세요.`
        const nlResp = await openai.responses.create({
          model: models.chat,
          instructions: nonLegalSystem,
          input: sanitizedQuery,
        })
        const shortAnswer = (nlResp as any).output_text?.trim() ?? ''
        const guidanceTail = [
          '',
          '혹시 법적 이슈로 이어질 수 있는 부분이 있다면, 변호사 상담 연결을 도와드릴 수 있어요.',
          '상담을 원하시면 성함과 선호하시는 연락 방법(전화/이메일), 가능하신 시간을 알려주실 수 있을까요?',
          '현재 상황을 한두 문장으로만 덧붙여 주시면 더 정확히 도와드릴게요.',
        ].join('\n')
        const finalAnswer = [shortAnswer, guidanceTail].join('\n')
        sendTextWithCitations(res, finalAnswer, [], sanitizedQuery)
      } catch (e) {
        // 한글 주석: 실패 시에도 대화를 끊지 않고 안내 및 CTA 제공
        const fallback = [
          '간단히 답변을 준비하는 중 문제가 발생했어요. 그래도 걱정 마세요.',
          '법적 이슈로 이어질 수 있는 부분이 있다면 변호사 상담 연결을 도와드릴 수 있어요.\n',
          '상담을 원하시면 성함과 선호하시는 연락 방법(전화/이메일), 가능하신 시간을 알려주시겠어요?',
        ].join('\n')
        sendTextWithCitations(res, fallback, [], sanitizedQuery)
      }
      return
    }

    // Create embedding from query
    const embeddingResponse = await openai.embeddings.create({
      model: models.embedding,
      input: sanitizedQuery.replaceAll('\n', ' '),
    })

    // Vercel 환경에서 embedding data가 undefined일 수 있음
    if (!embeddingResponse.data || !Array.isArray(embeddingResponse.data) || embeddingResponse.data.length === 0) {
      throw new ApplicationError('Invalid embedding response from OpenAI')
    }

    const [{ embedding }] = embeddingResponse.data

    const pageSections = await matchSectionsForQuery(embedding)
    if (!pageSections || !Array.isArray(pageSections)) {
      throw new ApplicationError('No matching page sections found')
    }

    const { contextText, usedSections } = buildContextFromSections(pageSections as any)
    // 한글 주석: 히스토리를 압축된 텍스트로 구성
    const historyText = trimmedHistory
      .map((m) => {
        const role = m.role === 'user' ? '사용자' : m.role === 'assistant' ? '어시스턴트' : '시스템'
        return `- ${role}: ${String(m.content || '').trim()}`
      })
      .join('\n')
    const prompt = buildKoreanLegalPrompt(contextText, sanitizedQuery, historyText)

    const chatMessage = {
      role: 'user' as const,
      content: prompt,
    }

    if (wantsStream) {
      const controller = new AbortController()
      let aborted = false
      const onClose = () => {
        aborted = true
        controller.abort()
      }
      res.on('close', onClose)

      const stream = await openai.responses.create(
        {
          model: models.chat,
          input: prompt,
          stream: true,
        },
        { signal: controller.signal as any }
      )
      try {
        writePlainTextHeaders(res)
        writeCitations(res, usedSections, sanitizedQuery)

        // 메타데이터 추적
        let responseId: string | undefined
        let modelId: string | undefined
        let usage: any | undefined

        for await (const event of stream as any) {
          const type = event?.type
          if (type === 'response.created') {
            responseId = event?.response?.id ?? event?.data?.id ?? responseId
            modelId = event?.response?.model ?? event?.data?.model ?? modelId
          } else if (type === 'response.output_text.delta') {
            const delta = event.delta || ''
            if (delta) await writeWithBackpressure(res, delta)
          } else if (type === 'response.completed') {
            // 완료 시점의 메타 수집 시도
            const r = event?.response ?? event?.data
            responseId = r?.id ?? responseId
            modelId = r?.model ?? modelId
            usage = r?.usage ?? usage
            break
          } else if (type === 'response.error') {
            console.error('🚨 OpenAI streaming error event:', event)
          }
          if (aborted) break
        }
        res.write(`\n\n<!-- END_CITATIONS: ${usedSections.length} sources used -->`)
        res.end()
      } catch (streamErr) {
        console.error('🚨 스트리밍 중 오류 발생:', streamErr)
        if (!res.headersSent) {
          res.status(500).json({ error: 'Streaming failed' })
        } else if (!res.writableEnded) {
          res.write(`\n\n<!-- STREAM_ERROR: Streaming failed -->`)
          res.end()
        }
      } finally {
        res.off('close', onClose)
      }
    } else {
      const completion = await openai.responses.create({
        model: models.chat,
        input: prompt,
      })

      const answer = (completion as any).output_text ?? ''
      sendTextWithCitations(res, answer, usedSections, sanitizedQuery)
    }
  } catch (err: unknown) {
    if (err instanceof UserError) {
      res.status(400).json({
        error: err.message,
        data: err.data,
      })
    } else if (err instanceof ApplicationError) {
      // 한글 주석: 애플리케이션 오류 처리
      res.status(500).json({
        error: 'There was an error processing your request',
      })
    } else {
      console.error('🚨 예상치 못한 서버 오류:', err)
      res.status(500).json({
        error: 'There was an error processing your request',
      })
    }
  }
}

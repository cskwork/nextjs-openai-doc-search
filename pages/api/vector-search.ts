import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { codeBlock, oneLine } from 'common-tags'
import { encode as encodeTokens } from 'gpt-tokenizer'
import OpenAI from 'openai'
import { ApplicationError, UserError } from '@/lib/errors'

// 공용 타입
type UsedSection = {
  id: number
  path: string
  heading: string
  similarity: number
  content_length: number
  token_count: number
}

// 응답 헬퍼: 공통 헤더 설정
function writePlainTextHeaders(res: NextApiResponse) {
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
  }
}

// 응답 헬퍼: 인용 주석 전송
function writeCitations(res: NextApiResponse, sources: UsedSection[], query: string) {
  const citationData = {
    type: 'citations',
    sources,
    query,
    timestamp: new Date().toISOString(),
  }
  res.write(`<!-- CITATIONS: ${JSON.stringify(citationData)} -->\n`)
}

// 응답 헬퍼: 단일 텍스트 응답 전송
function sendTextWithCitations(
  res: NextApiResponse,
  body: string,
  sources: UsedSection[],
  query: string
) {
  // 한글 주석: 텍스트 본문과 인용 메타를 함께 전송
  writePlainTextHeaders(res)
  writeCitations(res, sources, query)
  res.write(body)
  res.write(`\n\n<!-- END_CITATIONS: ${sources.length} sources used -->`)
  res.end()
}

// 유틸: 불리언 파싱 ("true"/true 허용)
function parseBooleanFlag(value: unknown): boolean {
  return value === true || value === 'true'
}

// 유틸: 서버용 Supabase 클라이언트
function createServerSupabaseClient(url: string, serviceKey: string) {
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

const openAiKey = process.env.OPENAI_KEY
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

// 모델 구성: 환경변수로 오버라이드 가능
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-5-mini'
const MODERATION_MODEL = process.env.OPENAI_MODERATION_MODEL || 'omni-moderation-latest'
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'

// @ts-ignore - OpenAI v4 SDK default export is a constructible client
const openai = new OpenAI({ apiKey: openAiKey })

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    // 한글 주석: 요청 및 환경 체크
    console.log('🚀 Vector search API 호출')
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' })
    }

    if (!openAiKey) {
      throw new ApplicationError('Missing environment variable OPENAI_KEY')
    }

    if (!supabaseUrl) {
      throw new ApplicationError('Missing environment variable NEXT_PUBLIC_SUPABASE_URL')
    }

    if (!supabaseServiceKey) {
      throw new ApplicationError('Missing environment variable SUPABASE_SERVICE_ROLE_KEY')
    }

    const requestData = req.body
    if (!requestData) {
      throw new UserError('Missing request data')
    }

    const { prompt: query } = requestData
    const wantsStream = parseBooleanFlag(requestData?.stream)

    if (!query) {
      throw new UserError('Missing query in request data')
    }

    const supabaseClient = createServerSupabaseClient(supabaseUrl, supabaseServiceKey)

    // Moderate the content to comply with OpenAI T&C
    const sanitizedQuery = query.trim()
    const moderationResponse = await openai.moderations.create({
      model: MODERATION_MODEL,
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
    let classifiedIntent: string = 'legal_question'
    let classifiedConfidence = 0
    const tryParseIntentJson = (text: string) => {
      try {
        return JSON.parse(text)
      } catch (_) {
        const m = text.match(/\{[\s\S]*\}/)
        if (m) {
          return JSON.parse(m[0])
        }
        return null
      }
    }
    try {
      const intentSystem = oneLine`
        당신은 한국어 법률 상담 도메인의 인텐트 분류기입니다. 사용자의 입력을 다음 중 하나로 분류하세요:
        "greeting" | "legal_question" | "smalltalk" | "non_legal" | "other".
        반드시 엄격한 JSON으로만 응답하세요. 형식: {"intent":"...","confidence":0.0~1.0}
        설명, 추가 텍스트, 코드블록 없이 JSON만 반환하세요.`
      const intentResp = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: intentSystem },
          { role: 'user', content: sanitizedQuery },
        ],
      })
      const rawIntentText = intentResp.choices?.[0]?.message?.content ?? ''
      console.log('🧭 인텐트 원문 응답:', rawIntentText)
      const parsed = tryParseIntentJson(rawIntentText)
      if (parsed?.intent) classifiedIntent = String(parsed.intent)
      if (typeof parsed?.confidence === 'number') classifiedConfidence = parsed.confidence
      if (!parsed) {
        console.warn('⚠️ 인텐트 JSON 파싱 실패, 기본값 사용')
      }
    } catch (e) {
      console.warn('⚠️ 인텐트 분류 실패, 기본값 사용')
    }

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
        const nlResp = await openai.chat.completions.create({
          model: CHAT_MODEL,
          messages: [
            { role: 'system', content: nonLegalSystem },
            { role: 'user', content: sanitizedQuery },
          ],
        })
        const shortAnswer = nlResp.choices?.[0]?.message?.content?.trim() ?? ''
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
      model: EMBEDDING_MODEL,
      input: sanitizedQuery.replaceAll('\n', ' '),
    })

    // Vercel 환경에서 embedding data가 undefined일 수 있음
    if (!embeddingResponse.data || !Array.isArray(embeddingResponse.data) || embeddingResponse.data.length === 0) {
      throw new ApplicationError('Invalid embedding response from OpenAI')
    }

    const [{ embedding }] = embeddingResponse.data

    // Supabase RPC 호출

    const { error: matchError, data: pageSections } = await supabaseClient.rpc(
      'match_page_sections',
      {
        embedding,
        match_threshold: 0.5, // 임계값을 낮춤 (0.78 → 0.5)
        match_count: 10,
        min_content_length: 30, // 최소 길이도 낮춤 (50 → 30)
      }
    )

    if (matchError) {
      throw new ApplicationError('Failed to match page sections', matchError)
    }

    // Vercel 환경에서 pageSections가 undefined일 수 있으므로 방어적 처리
    if (!pageSections || !Array.isArray(pageSections)) {
      throw new ApplicationError('No matching page sections found')
    }

    let tokenCount = 0
    let contextText = ''
    const usedSections: UsedSection[] = []

    for (let i = 0; i < pageSections.length; i++) {
      const pageSection = pageSections[i]
      // 섹션 데이터 방어적 체크
      if (!pageSection || !pageSection.content) {
        continue
      }

      const content = pageSection.content
      const sectionTokenCount = encodeTokens(content).length
      
      if (tokenCount + sectionTokenCount >= 1500) {
        break
      }

      tokenCount += sectionTokenCount
      contextText += `${content.trim()}\n---\n`
      
      // 사용된 섹션 메타데이터 저장
      usedSections.push({
        id: pageSection.id || i,
        path: pageSection.path || 'unknown',
        heading: pageSection.heading || '제목 없음',
        similarity: pageSection.similarity || 0,
        content_length: content.length,
        token_count: sectionTokenCount,
      })
    }

    // 안전한 템플릿 생성을 위한 변수들 확인
    const safeContextText = contextText || ''
    const safeSanitizedQuery = sanitizedQuery || ''

    const prompt = codeBlock`
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
      ${safeSanitizedQuery}
      """

      만약 제공된 법적 정보만으로 충분히 답하기 어렵다면 다음처럼 말하세요:
      "제공된 정보로는 정확한 답변을 드리기 어렵습니다. 전문 변호사와 상담하시기를 권합니다."
    `

    const chatMessage = {
      role: 'user' as const,
      content: prompt,
    }

    if (wantsStream) {
      const responseStream = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [chatMessage],
        stream: true,
      })
      try {
        writePlainTextHeaders(res)
        writeCitations(res, usedSections, sanitizedQuery)

        // Stream chunks from the official OpenAI SDK
        let chunkCount = 0
        for await (const chunk of responseStream) {
          const delta = chunk.choices?.[0]?.delta?.content
          if (delta) {
            chunkCount++
            res.write(delta)
          }
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
      }
    } else {
      const completion = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [chatMessage],
      })

      const answer = completion.choices?.[0]?.message?.content ?? ''
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

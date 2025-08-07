import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { codeBlock, oneLine } from 'common-tags'
import GPT3Tokenizer from 'gpt3-tokenizer'
import {
  Configuration,
  OpenAIApi,
  CreateModerationResponse,
  CreateEmbeddingResponse,
  ChatCompletionRequestMessage,
} from 'openai-edge'
import { OpenAIStream, StreamingTextResponse } from 'ai'
import { ApplicationError, UserError } from '@/lib/errors'

const openAiKey = process.env.OPENAI_KEY
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const config = new Configuration({
  apiKey: openAiKey,
})
const openai = new OpenAIApi(config)

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    console.log('🚀 Vector search API 호출 시작')
    console.log('📋 요청 메서드:', req.method)
    console.log('🔧 환경변수 확인:', {
      hasOpenAiKey: !!openAiKey,
      hasSupabaseUrl: !!supabaseUrl,
      hasSupabaseServiceKey: !!supabaseServiceKey,
    })

    if (!openAiKey) {
      throw new ApplicationError('Missing environment variable OPENAI_KEY')
    }

    if (!supabaseUrl) {
      throw new ApplicationError('Missing environment variable SUPABASE_URL')
    }

    if (!supabaseServiceKey) {
      throw new ApplicationError('Missing environment variable SUPABASE_SERVICE_ROLE_KEY')
    }

    const requestData = req.body
    console.log('📦 요청 데이터 타입:', typeof requestData)
    console.log('📦 요청 데이터 존재여부:', !!requestData)

    if (!requestData) {
      throw new UserError('Missing request data')
    }

    const { prompt: query } = requestData
    console.log('🔍 쿼리 길이:', query?.length || 0)
    console.log('🔍 쿼리 미리보기:', query?.substring(0, 100))

    if (!query) {
      throw new UserError('Missing query in request data')
    }

    const supabaseClient = createClient(supabaseUrl, supabaseServiceKey)

    // Moderate the content to comply with OpenAI T&C
    const sanitizedQuery = query.trim()
    console.log('🛡️ OpenAI 검열 시작...')

    const moderationResponse: CreateModerationResponse = await openai
      .createModeration({ input: sanitizedQuery })
      .then((res) => res.json())

    console.log('🛡️ 검열 응답:', moderationResponse)
    console.log('🛡️ 검열 완료, 결과:', moderationResponse.results?.length > 0 ? 'OK' : 'ERROR')

    // Vercel 환경에서 moderationResponse.results가 undefined일 수 있음
    if (
      !moderationResponse.results ||
      !Array.isArray(moderationResponse.results) ||
      moderationResponse.results.length === 0
    ) {
      console.log('❌ 검열 응답이 유효하지 않음:', moderationResponse)
      throw new ApplicationError('Invalid moderation response from OpenAI')
    }

    const [results] = moderationResponse.results

    if (results.flagged) {
      console.log('🚫 콘텐츠 플래그됨:', results.categories)
      throw new UserError('Flagged content', {
        flagged: true,
        categories: results.categories,
      })
    }

    // Create embedding from query
    console.log('🔢 임베딩 생성 시작...')
    const embeddingResponse = await openai.createEmbedding({
      model: 'text-embedding-3-small',
      input: sanitizedQuery.replaceAll('\n', ' '),
      dimensions: 1536, // 1536 차원으로 명시적 설정
    })

    console.log('🔢 임베딩 응답 상태:', embeddingResponse.status)
    if (embeddingResponse.status !== 200) {
      throw new ApplicationError('Failed to create embedding for question', embeddingResponse)
    }

    const embeddingData: CreateEmbeddingResponse = await embeddingResponse.json()
    console.log('🔢 임베딩 응답 구조:', {
      hasData: !!embeddingData.data,
      dataLength: embeddingData.data?.length,
    })

    // Vercel 환경에서 embedding data가 undefined일 수 있음
    if (
      !embeddingData.data ||
      !Array.isArray(embeddingData.data) ||
      embeddingData.data.length === 0
    ) {
      console.log('❌ 임베딩 데이터가 유효하지 않음:', embeddingData)
      throw new ApplicationError('Invalid embedding response from OpenAI')
    }

    const [{ embedding }] = embeddingData.data

    console.log('🔢 임베딩 생성 완료, 차원:', embedding?.length || 'unknown')

    console.log('🗄️ Supabase RPC 호출 시작...')
    
    // 먼저 테이블에 데이터가 있는지 확인
    const { data: totalSections, error: countError } = await supabaseClient
      .from('nods_page_section')
      .select('id, content, heading', { count: 'exact' })
      .limit(5)
    
    console.log('📊 테이블 데이터 확인:', {
      hasError: !!countError,
      sectionsCount: totalSections?.length || 0,
      firstSection: totalSections?.[0] ? {
        id: totalSections[0].id,
        heading: totalSections[0].heading,
        contentLength: totalSections[0].content?.length || 0
      } : null
    })

    const { error: matchError, data: pageSections } = await supabaseClient.rpc(
      'match_page_sections',
      {
        embedding,
        match_threshold: 0.5, // 임계값을 낮춤 (0.78 → 0.5)
        match_count: 10,
        min_content_length: 30, // 최소 길이도 낮춤 (50 → 30)
      }
    )

    console.log('🗄️ RPC 응답:', {
      hasError: !!matchError,
      errorMessage: matchError?.message,
      pageSectionsType: typeof pageSections,
      pageSectionsLength: Array.isArray(pageSections) ? pageSections.length : 'N/A',
      isArray: Array.isArray(pageSections),
    })

    if (matchError) {
      console.log('❌ Supabase RPC 오류:', matchError)
      throw new ApplicationError('Failed to match page sections', matchError)
    }

    // Vercel 환경에서 pageSections가 undefined일 수 있으므로 방어적 처리
    if (!pageSections || !Array.isArray(pageSections)) {
      console.log('❌ 유효하지 않은 pageSections:', { pageSections, type: typeof pageSections })
      throw new ApplicationError('No matching page sections found')
    }

    console.log('📝 컨텍스트 처리 시작...')
    const tokenizer = new GPT3Tokenizer({ type: 'gpt3' })
    let tokenCount = 0
    let contextText = ''
    const usedSections: Array<{
      id: number;
      path: string;
      heading: string;
      similarity: number;
      content_length: number;
      token_count: number;
    }> = []

    for (let i = 0; i < pageSections.length; i++) {
      const pageSection = pageSections[i]
      console.log(`📄 섹션 ${i} 처리 중:`, {
        hasSection: !!pageSection,
        hasContent: !!pageSection?.content,
        contentType: typeof pageSection?.content,
        contentLength: pageSection?.content?.length || 0,
        similarity: pageSection?.similarity,
        path: pageSection?.path,
        heading: pageSection?.heading,
      })

      // 섹션 데이터 방어적 체크
      if (!pageSection || !pageSection.content) {
        console.log(`⚠️ 섹션 ${i} 스킵: 유효하지 않은 데이터`)
        continue
      }

      const content = pageSection.content
      const encoded = tokenizer.encode(content)
      const sectionTokenCount = encoded.text.length
      
      if (tokenCount + sectionTokenCount >= 1500) {
        console.log('⚠️ 토큰 한도 도달, 섹션 처리 중단:', { 섹션수: i, 토큰수: tokenCount })
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
      
      console.log(`✅ 섹션 ${i} 포함됨:`, {
        id: pageSection.id,
        path: pageSection.path,
        heading: pageSection.heading?.substring(0, 50),
        similarity: pageSection.similarity,
        tokens: sectionTokenCount,
      })
    }

    console.log('📝 컨텍스트 처리 완료:', {
      총섹션수: pageSections.length,
      처리된섹션수: contextText.split('---').length - 1,
      최종토큰수: tokenCount,
      컨텍스트길이: contextText.length,
    })
    
    // 사용된 컨텍스트 소스 상세 로깅
    console.log('📚 사용된 컨텍스트 소스들:')
    usedSections.forEach((section, index) => {
      console.log(`  [${index + 1}] ${section.path} - ${section.heading}`, {
        similarity: section.similarity.toFixed(4),
        tokens: section.token_count,
        content_chars: section.content_length,
      })
    })

    // 안전한 템플릿 생성을 위한 변수들 확인
    const safeContextText = contextText || ''
    const safeSanitizedQuery = sanitizedQuery || ''

    console.log('📋 프롬프트 생성 준비:', {
      contextTextLength: safeContextText.length,
      queryLength: safeSanitizedQuery.length,
      hasCodeBlock: typeof codeBlock === 'function',
      hasOneLine: typeof oneLine === 'function',
    })

    const prompt = codeBlock`
      ${oneLine`
        당신은 대한민국 법률 전문가입니다. 다음 법적 정보만을 바탕으로 질문에 대한 
        신중하고 정확한 답변을 제공해주세요. 법적 정보에 없는 내용은 만들지 마세요.
        답변은 한국어로 작성하며, 답변을 제공할 수 없는 경우에는 "제공된 정보로는 
        정확한 답변을 드리기 어렵습니다. 전문 변호사와 상담하시기를 권합니다."라고 
        답변해주세요.
      `}

      법적 정보:
      ${safeContextText}

      질문: """
      ${safeSanitizedQuery}
      """

      답변 시 다음 사항을 준수해주세요:
      1. 정확하고 신중한 법적 조언 제공
      2. 제공된 법적 정보만으로 답변
      3. 구체적인 사안에 대해서는 전문 변호사 상담 권유
      
      답변:
    `

    console.log('📋 프롬프트 생성 완료, 길이:', prompt?.length || 'unknown')

    const chatMessage: ChatCompletionRequestMessage = {
      role: 'user',
      content: prompt,
    }

    console.log('🤖 GPT 완료 요청 시작...')
    const response = await openai.createChatCompletion({
      model: 'gpt-4.1',
      messages: [chatMessage],
      max_tokens: 512,
      temperature: 0,
      stream: true,
    })

    console.log('🤖 GPT 응답 상태:', response.status)
    if (!response.ok) {
      const error = await response.json()
      console.log('❌ GPT 완료 실패:', error)
      throw new ApplicationError('Failed to generate completion', error)
    }

    console.log('📡 스트리밍 응답 시작...')
    
    // Set headers for SSE with citations
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    
    // Send citation metadata first as a special message
    const citationData = {
      type: 'citations',
      sources: usedSections,
      query: sanitizedQuery,
      timestamp: new Date().toISOString(),
    }
    
    // Send citation info as a JSON comment that won't affect the stream
    res.write(`<!-- CITATIONS: ${JSON.stringify(citationData)} -->\n`)
    console.log('📚 인용 정보 전송 완료:', usedSections.length, '개 소스')
    
    // Transform the response into a readable stream
    const stream = OpenAIStream(response)
    const reader = stream.getReader()
    let chunkCount = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        console.log('✅ 스트리밍 완료, 총 청크:', chunkCount)
        // Send final citation summary
        res.write(`\n\n<!-- END_CITATIONS: ${usedSections.length} sources used -->`)
        break
      }
      chunkCount++
      res.write(value)
    }
    res.end()
  } catch (err: unknown) {
    console.log('💥 API 오류 발생:', err)
    if (err instanceof UserError) {
      console.log('👤 사용자 오류:', err.message, err.data)
      res.status(400).json({
        error: err.message,
        data: err.data,
      })
    } else if (err instanceof ApplicationError) {
      // Print out application errors with their additional data
      console.error(`🔧 애플리케이션 오류: ${err.message}: ${JSON.stringify(err.data)}`)
      res.status(500).json({
        error: 'There was an error processing your request',
      })
    } else {
      // Print out unexpected errors as is to help with debugging
      console.error('🚨 예상치 못한 오류:', err)
      res.status(500).json({
        error: 'There was an error processing your request',
      })
    }
  }
}

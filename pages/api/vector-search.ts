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
      hasSupabaseServiceKey: !!supabaseServiceKey
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

    console.log('🛡️ 검열 완료, 결과:', moderationResponse.results?.length > 0 ? 'OK' : 'ERROR')
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
      model: 'text-embedding-ada-002',
      input: sanitizedQuery.replaceAll('\n', ' '),
    })

    console.log('🔢 임베딩 응답 상태:', embeddingResponse.status)
    if (embeddingResponse.status !== 200) {
      throw new ApplicationError('Failed to create embedding for question', embeddingResponse)
    }

    const {
      data: [{ embedding }],
    }: CreateEmbeddingResponse = await embeddingResponse.json()
    
    console.log('🔢 임베딩 생성 완료, 차원:', embedding?.length || 'unknown')

    console.log('🗄️ Supabase RPC 호출 시작...')
    const { error: matchError, data: pageSections } = await supabaseClient.rpc(
      'match_page_sections',
      {
        embedding,
        match_threshold: 0.78,
        match_count: 10,
        min_content_length: 50,
      }
    )

    console.log('🗄️ RPC 응답:', {
      hasError: !!matchError,
      errorMessage: matchError?.message,
      pageSectionsType: typeof pageSections,
      pageSectionsLength: Array.isArray(pageSections) ? pageSections.length : 'N/A',
      isArray: Array.isArray(pageSections)
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

    for (let i = 0; i < pageSections.length; i++) {
      const pageSection = pageSections[i]
      const content = pageSection.content
      const encoded = tokenizer.encode(content)
      tokenCount += encoded.text.length

      if (tokenCount >= 1500) {
        console.log('⚠️ 토큰 한도 도달, 섹션 처리 중단:', { 섹션수: i, 토큰수: tokenCount })
        break
      }

      contextText += `${content.trim()}\n---\n`
    }
    
    console.log('📝 컨텍스트 처리 완료:', { 
      총섹션수: pageSections.length, 
      처리된섹션수: contextText.split('---').length - 1,
      최종토큰수: tokenCount,
      컨텍스트길이: contextText.length 
    })

    const prompt = codeBlock`
      ${oneLine`
        You are a very enthusiastic Supabase representative who loves
        to help people! Given the following sections from the Supabase
        documentation, answer the question using only that information,
        outputted in markdown format. If you are unsure and the answer
        is not explicitly written in the documentation, say
        "Sorry, I don't know how to help with that."
      `}

      Context sections:
      ${contextText}

      Question: """
      ${sanitizedQuery}
      """

      Answer as markdown (including related code snippets if available):
    `

    const chatMessage: ChatCompletionRequestMessage = {
      role: 'user',
      content: prompt,
    }

    console.log('🤖 GPT 완료 요청 시작...')
    const response = await openai.createChatCompletion({
      model: 'gpt-3.5-turbo',
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
    // Transform the response into a readable stream
    const stream = OpenAIStream(response)
    const reader = stream.getReader()
    let chunkCount = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        console.log('✅ 스트리밍 완료, 총 청크:', chunkCount)
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

// 한글 주석: OpenAI 클라이언트 초기화 및 공용 유틸
import OpenAI from 'openai'
import { getConfig } from '@/lib/config'

let openaiSingleton: OpenAI | null = null

export function getOpenAIClient(): OpenAI {
  if (openaiSingleton) return openaiSingleton
  const { openaiKey } = getConfig()
  // @ts-ignore - OpenAI v4 SDK default export is constructible
  openaiSingleton = new OpenAI({
    apiKey: openaiKey,
    // 한글 주석: 지연을 줄이기 위해 타임아웃과 재시도 횟수를 보수적으로 설정
    // 환경변수로 조정 가능 (기본: 30초, 1회 재시도 없음)
    // OpenAI SDK v4 옵션: timeout(ms), maxRetries
    timeout: Number(process.env.OPENAI_TIMEOUT_MS || 30000),
    maxRetries: Number(process.env.OPENAI_MAX_RETRIES || 1),
  })
  return openaiSingleton
}

export function formatOpenAIError(err: unknown): string {
  const anyErr = err as any
  const status = anyErr?.status || anyErr?.response?.status
  const code = anyErr?.code || anyErr?.error?.code
  const message = anyErr?.message || anyErr?.error?.message || anyErr?.response?.data || ''
  return [
    status ? `status=${status}` : '',
    code ? `code=${code}` : '',
    message ? `message=${String(message).slice(0, 300)}` : '',
  ]
    .filter(Boolean)
    .join(' ')
}



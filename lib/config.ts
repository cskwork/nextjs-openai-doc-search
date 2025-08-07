// 한글 주석: 애플리케이션 전역 설정 및 환경변수 유효성 검사 모듈

export type AppConfig = {
  openaiKey: string
  supabaseUrl: string
  supabaseServiceRoleKey: string
  models: {
    // 한글 주석: 인텐트 전용 모델 (인텐트 분류에만 사용)
    intent: string
    chat: string
    moderation: string
    embedding: string
  }
}

let cachedConfig: AppConfig | null = null

export function getConfig(): AppConfig {
  if (cachedConfig) return cachedConfig

  const openaiKey = process.env.OPENAI_KEY
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!openaiKey) {
    throw new Error('Missing environment variable OPENAI_KEY')
  }
  if (!supabaseUrl) {
    throw new Error('Missing environment variable NEXT_PUBLIC_SUPABASE_URL')
  }
  if (!supabaseServiceRoleKey) {
    throw new Error('Missing environment variable SUPABASE_SERVICE_ROLE_KEY')
  }

  const config: AppConfig = {
    openaiKey,
    supabaseUrl,
    supabaseServiceRoleKey,
    models: {
      // 한글 주석: 인텐트 분류기는 경량 "gpt-5-nano" 기본값 사용
      intent: process.env.OPENAI_INTENT_MODEL || 'gpt-5-nano',
      // 한글 주석: 기존 기본값을 유지하여 동작 변화 최소화
      chat: process.env.OPENAI_CHAT_MODEL || 'gpt-5-mini',
      moderation: process.env.OPENAI_MODERATION_MODEL || 'omni-moderation-latest',
      embedding: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    },
  }

  cachedConfig = config
  return config
}



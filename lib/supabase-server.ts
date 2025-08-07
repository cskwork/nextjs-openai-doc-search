// 한글 주석: 서버 사이드 Supabase 클라이언트 팩토리
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConfig } from '@/lib/config'

let supabaseSingleton: SupabaseClient | null = null

export function getServerSupabaseClient(): SupabaseClient {
  if (supabaseSingleton) return supabaseSingleton
  const { supabaseUrl, supabaseServiceRoleKey } = getConfig()
  supabaseSingleton = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return supabaseSingleton
}



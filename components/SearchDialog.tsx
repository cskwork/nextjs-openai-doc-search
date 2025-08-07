'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCompletion } from 'ai/react'
import { Loader, User, Frown, Send, Scale, FileText, MessageCircle, Clock, BookOpen, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react'

// 소스 인용 정보 타입 정의
interface CitationSource {
  id: number
  path: string
  heading: string
  similarity: number
  content_length: number
  token_count: number
}

// 메시지 타입 정의
interface Message {
  id: string
  content: string
  isUser: boolean
  timestamp: Date
  isLoading?: boolean
  citations?: CitationSource[]
}

// 빠른 질문 템플릿
const QUICK_QUESTIONS = [
  '계약서 작성 시 주의사항은 무엇인가요?',
  '직장에서 부당한 대우를 받았을 때 어떻게 해야 하나요?',
  '임대차 계약 만료 후 보증금 반환은 어떻게 이루어지나요?',
  '교통사고 발생 시 처리 절차를 알려주세요.',
]

export function SearchDialog() {
  const STORAGE_KEY = 'legal-assistant:messages:v1'
  const [messages, setMessages] = React.useState<Message[]>([
    {
      id: '1',
      content:
        '안녕하세요! 법무 상담 AI 어시스턴트입니다. 법적 문제에 대해 도움을 드릴 수 있습니다. 어떤 문의사항이 있으시나요?',
      isUser: false,
      timestamp: new Date(),
    },
  ])
  const [query, setQuery] = React.useState<string>('')
  const [expandedCitations, setExpandedCitations] = React.useState<Record<string, boolean>>({})
  const messagesEndRef = React.useRef<HTMLDivElement>(null)
  
  // 인용 정보 파싱 함수
  const parseCitations = (response: string): { content: string; citations: CitationSource[] } => {
    const citationMatch = response.match(/<!-- CITATIONS: (.*?) -->/)
    let citations: CitationSource[] = []
    let content = response
    
    if (citationMatch) {
      try {
        const citationData = JSON.parse(citationMatch[1])
        citations = citationData.sources || []
        // Remove citation comments from content
        content = response.replace(/<!-- CITATIONS: .*? -->/g, '')
                         .replace(/<!-- END_CITATIONS: .*? -->/g, '')
                         .trim()
      } catch (error) {
        console.error('인용 정보 파싱 오류:', error)
      }
    }
    
    return { content, citations }
  }

  const historyLimitDefault = React.useMemo(() => {
    const env = Number(process.env.NEXT_PUBLIC_CHAT_HISTORY_LIMIT || 3)
    return Number.isFinite(env) && env > 0 ? env : 3
  }, [])

  const { complete, completion, isLoading, error } = useCompletion({
    api: '/api/vector-search',
    onFinish: (prompt: string, finalText: string) => {
      // 인용 정보 파싱 (최종 완료 시)
      const { content, citations } = parseCitations(finalText)
      setMessages((prev) => {
        const next = [...prev]
        // 마지막 어시스턴트 메시지를 찾아 최종 내용/인용으로 교체
        for (let i = next.length - 1; i >= 0; i--) {
          if (!next[i].isUser) {
            next[i] = {
              ...next[i],
              isLoading: false,
              content: content,
              citations,
              timestamp: new Date(),
            }
            return next
          }
        }
        // 방어적: 없을 경우 새로 추가
        return [
          ...next,
          {
            id: Date.now().toString(),
            content,
            isUser: false,
            timestamp: new Date(),
            citations,
          },
        ]
      })
    },
  })

  // 새로고침 시 채팅 기록 복원
  React.useEffect(() => {
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
      if (raw) {
        const parsed = JSON.parse(raw) as Array<
          Omit<Message, 'timestamp'> & { timestamp: string | number }
        >
        const restored: Message[] = parsed.map((m) => ({
          ...m,
          // 문자열/숫자 타임스탬프를 Date로 복원
          timestamp: new Date(m.timestamp),
        }))
        if (restored.length > 0) {
          setMessages(restored)
        }
      }
    } catch (e) {
      console.error('채팅 기록 복원 실패:', e)
    }
    // 최초 마운트 시 1회만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 메시지 변경 시 저장
  React.useEffect(() => {
    try {
      if (typeof window === 'undefined') return
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages))
    } catch (e) {
      console.error('채팅 기록 저장 실패:', e)
    }
  }, [messages])

  // 스트리밍 중간 표시용: CITATIONS 주석 제거
  const sanitizeStreaming = React.useCallback((text: string) => {
    return text
      .replace(/<!-- CITATIONS: [\s\S]*? -->/g, '')
      .replace(/<!-- END_CITATIONS: [\s\S]*? -->/g, '')
      .trimStart()
  }, [])

  // 스트리밍 토큰을 실시간으로 메시지에 반영
  React.useEffect(() => {
    if (!completion) return
    const interim = sanitizeStreaming(completion)
    if (!interim) return
    setMessages((prev) => {
      const next = [...prev]
      // 가장 마지막 어시스턴트(또는 로딩) 메시지를 업데이트
      let updated = false
      for (let i = next.length - 1; i >= 0; i--) {
        const msg = next[i]
        if (!msg.isUser) {
          next[i] = {
            ...msg,
            content: interim,
            isLoading: false,
            timestamp: new Date(),
          }
          updated = true
          break
        }
      }
      // 방어적: 없다면 하나 생성
      if (!updated) {
        next.push({
          id: Date.now().toString(),
          content: interim,
          isUser: false,
          timestamp: new Date(),
          isLoading: false,
        })
      }
      return next
    })
  }, [completion, sanitizeStreaming])

  // 자동 스크롤
  React.useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSubmit: React.FormEventHandler<HTMLFormElement> = (e) => {
    e.preventDefault()
    if (!query.trim()) return

    // 사용자 메시지 추가
    const userMessage: Message = {
      id: Date.now().toString(),
      content: query,
      isUser: true,
      timestamp: new Date(),
    }

    // 로딩 메시지 추가
    const loadingMessage: Message = {
      id: (Date.now() + 1).toString(),
      content: '',
      isUser: false,
      timestamp: new Date(),
      isLoading: true,
    }

    setMessages((prev) => [...prev, userMessage, loadingMessage])
    // 한글 주석: 최근 historyLimitDefault개의 메시지를 서버로 전달
    const history = messages
      .filter((m) => m.content && !m.isLoading)
      .map((m) => ({ role: m.isUser ? 'user' : 'assistant', content: m.content }))
      .slice(-historyLimitDefault)
    complete(query, { body: { history, historyLimit: historyLimitDefault } })
    setQuery('')
  }

  const handleQuickQuestion = (question: string) => {
    setQuery(question)
  }

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
    })
  }
  
  const toggleCitations = (messageId: string) => {
    setExpandedCitations(prev => ({
      ...prev,
      [messageId]: !prev[messageId]
    }))
  }
  
  const formatSimilarity = (similarity: number) => {
    return `${(similarity * 100).toFixed(1)}%`
  }

  return (
    <div className="flex flex-col h-screen max-w-4xl mx-auto bg-gradient-to-br from-slate-50 to-blue-50">
      {/* 헤더 */}
      <header className="bg-gradient-to-r from-blue-900 to-blue-800 text-white p-6 shadow-lg">
        <div className="flex items-center gap-4">
          <div className="bg-white/20 p-3 rounded-full">
            <Scale className="w-8 h-8" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">법무 상담 AI</h1>
            <p className="text-blue-100 text-sm">
              전문적이고 신뢰할 수 있는 법적 조언을 제공합니다
            </p>
          </div>
        </div>
      </header>

      {/* 메시지 영역 */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex gap-3 ${
              message.isUser ? 'justify-end' : 'justify-start'
            } animate-fade-in`}
          >
            {!message.isUser && (
              <div className="flex-shrink-0 w-10 h-10 bg-gradient-to-br from-blue-500 to-blue-600 rounded-full flex items-center justify-center shadow-lg">
                <Scale className="w-5 h-5 text-white" />
              </div>
            )}

            <div
              className={`max-w-2xl px-4 py-3 rounded-2xl shadow-md ${
                message.isUser
                  ? 'bg-gradient-to-r from-blue-600 to-blue-700 text-white rounded-br-md'
                  : 'bg-white border border-gray-200 text-gray-800 rounded-bl-md'
              }`}
            >
              {message.isLoading ? (
                <div className="flex items-center gap-2 py-2">
                  <Loader className="w-4 h-4 animate-spin text-blue-500" />
                  <span className="text-gray-500 text-sm">답변을 생성하고 있습니다...</span>
                </div>
              ) : (
                <>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
                  
                  {/* 인용 정보 표시 */}
                  {message.citations && message.citations.length > 0 && (
                    <div className="mt-3 border-t border-gray-100 pt-3">
                      <button
                        onClick={() => toggleCitations(message.id)}
                        className="flex items-center gap-2 text-xs text-gray-600 hover:text-gray-800 font-medium mb-2"
                      >
                        <BookOpen className="w-3 h-3" />
                        소스 {message.citations.length}개
                        {expandedCitations[message.id] ? 
                          <ChevronUp className="w-3 h-3" /> : 
                          <ChevronDown className="w-3 h-3" />
                        }
                      </button>
                      
                      {expandedCitations[message.id] && (
                        <div className="space-y-2">
                          {message.citations.map((citation, index) => (
                            <div
                              key={`${citation.id}-${index}`}
                              className="bg-gray-50 rounded-lg p-3 border border-gray-200"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className="text-xs font-semibold text-blue-600">
                                      #{index + 1}
                                    </span>
                                    <h4 className="text-xs font-medium text-gray-800 line-clamp-1">
                                      {citation.heading}
                                    </h4>
                                  </div>
                                  <p className="text-xs text-gray-600 mb-2">
                                    {citation.path}
                                  </p>
                                  <div className="flex items-center gap-3 text-xs text-gray-500">
                                    <span className="flex items-center gap-1">
                                      <ExternalLink className="w-3 h-3" />
                                      유사도: {formatSimilarity(citation.similarity)}
                                    </span>
                                    <span>내용: {citation.content_length}자</span>
                                    <span>토큰: {citation.token_count}</span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  
                  <div
                    className={`text-xs mt-2 flex items-center gap-1 ${
                      message.isUser ? 'text-blue-100' : 'text-gray-400'
                    }`}
                  >
                    <Clock className="w-3 h-3" />
                    {formatTime(message.timestamp)}
                  </div>
                </>
              )}
            </div>

            {message.isUser && (
              <div className="flex-shrink-0 w-10 h-10 bg-gradient-to-br from-gray-400 to-gray-500 rounded-full flex items-center justify-center shadow-lg">
                <User className="w-5 h-5 text-white" />
              </div>
            )}
          </div>
        ))}

        {error && (
          <div className="flex justify-start">
            <div className="max-w-2xl px-4 py-3 rounded-2xl bg-red-50 border border-red-200 text-red-700 shadow-md">
              <div className="flex items-center gap-2">
                <Frown className="w-5 h-5" />
                <span>죄송합니다. 일시적인 오류가 발생했습니다. 다시 시도해주세요.</span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 빠른 질문 영역 */}
      {messages.length <= 1 && (
        <div className="px-6 pb-4">
          <div className="bg-white rounded-xl p-4 shadow-md border border-gray-200">
            <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
              <MessageCircle className="w-4 h-4" />
              자주 묻는 질문
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {QUICK_QUESTIONS.map((question, index) => (
                <button
                  key={index}
                  onClick={() => handleQuickQuestion(question)}
                  className="text-left text-xs p-3 bg-gradient-to-r from-gray-50 to-blue-50 hover:from-blue-50 hover:to-blue-100 rounded-lg border border-gray-200 hover:border-blue-300 transition-all duration-200 hover:shadow-md"
                >
                  {question}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 입력 영역 */}
      <div className="p-6 bg-white border-t border-gray-200 shadow-lg">
        <form onSubmit={handleSubmit} className="flex gap-3">
          <div className="flex-1 relative">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="법적 문의사항을 입력하세요..."
              className="pr-12 py-3 border-2 border-gray-200 focus:border-blue-500 rounded-xl shadow-sm transition-all duration-200"
              disabled={isLoading}
            />
          </div>
          <Button
            type="submit"
            disabled={!query.trim() || isLoading}
            className="px-6 py-3 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 rounded-xl shadow-md transition-all duration-200 disabled:opacity-50"
          >
            {isLoading ? <Loader className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
          </Button>
        </form>

        {/* 면책 조항 */}
        <div className="mt-3 text-center">
          <p className="text-xs text-gray-500 flex items-center justify-center gap-1">
            <FileText className="w-3 h-3" />본 상담은 일반적인 법적 정보 제공 목적이며, 구체적인
            사안에 대해서는 전문 변호사와 상담하시기 바랍니다.
          </p>
        </div>
      </div>
    </div>
  )
}

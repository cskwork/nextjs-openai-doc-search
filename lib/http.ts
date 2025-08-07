// 한글 주석: API 응답 헬퍼 및 스트리밍 안전 쓰기 유틸
import type { NextApiResponse } from 'next'
import { once } from 'events'

export function writePlainTextHeaders(res: NextApiResponse) {
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
  }
}

export async function writeWithBackpressure(res: NextApiResponse, chunk: string) {
  const ok = res.write(chunk)
  if (!ok) {
    await once(res, 'drain')
  }
}

export type Citation = {
  id: number
  path: string
  heading: string
  similarity: number
  content_length: number
  token_count: number
}

export function writeCitations(res: NextApiResponse, sources: Citation[], query: string) {
  const citationData = {
    type: 'citations',
    sources,
    query,
    timestamp: new Date().toISOString(),
  }
  res.write(`<!-- CITATIONS: ${JSON.stringify(citationData)} -->\n`)
}

export function sendTextWithCitations(
  res: NextApiResponse,
  body: string,
  sources: Citation[],
  query: string
) {
  writePlainTextHeaders(res)
  writeCitations(res, sources, query)
  res.write(body)
  res.write(`\n\n<!-- END_CITATIONS: ${sources.length} sources used -->`)
  res.end()
}

export function parseBooleanFlag(value: unknown): boolean {
  return value === true || value === 'true'
}



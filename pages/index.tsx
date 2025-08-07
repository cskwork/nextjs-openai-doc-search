import Head from 'next/head'
import { Inter } from 'next/font/google'
import { SearchDialog } from '@/components/SearchDialog'

const inter = Inter({ subsets: ['latin'] })

export default function Home() {
  return (
    <>
      <Head>
        <title>법무 상담 AI - 전문적이고 신뢰할 수 있는 법률 조언</title>
        <meta
          name="description"
          content="AI 기반 법무 상담 서비스입니다. 계약법, 노동법, 부동산법 등 다양한 법적 문제에 대한 전문적인 조언을 받으실 수 있습니다."
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="keywords"
          content="법무상담, AI상담, 계약법, 노동법, 부동산법, 교통사고, 법률조언"
        />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <SearchDialog />
    </>
  )
}

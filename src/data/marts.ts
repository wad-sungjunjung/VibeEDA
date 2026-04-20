import type { MartMeta } from '@/types'

export const MART_CATALOG: MartMeta[] = [
  {
    key: 'ad_sales_mart',
    description: '일별 광고 판매 집계 마트',
    keywords: ['매출', '판매', '광고', '지역', '시도', '시군구', 'ctr', '노출', '클릭'],
    columns: [
      { name: 'sale_date', type: 'DATE', desc: '판매일자' },
      { name: 'sido', type: 'VARCHAR', desc: '시도' },
      { name: 'sigungu', type: 'VARCHAR', desc: '시군구' },
      { name: 'land_name', type: 'VARCHAR', desc: '판매처/지면명' },
      { name: 'product_id', type: 'VARCHAR', desc: '광고 상품 ID' },
      { name: 'sales_amount', type: 'NUMBER', desc: '매출액(원)' },
      { name: 'impressions', type: 'NUMBER', desc: '노출수' },
      { name: 'clicks', type: 'NUMBER', desc: '클릭수' },
    ],
    rules: [
      '지역별 판매 상한선 존재',
      '동일 상품은 전 판매처 동일 단가',
      'sale_date 기준 파티셔닝',
    ],
    recommendationScore: 3.5,
    updatedAt: '2026-04-15T00:00:00Z',
  },
  {
    key: 'store_info',
    description: '판매처 기본 정보 마트',
    keywords: ['판매처', '지면', '점포', '가맹', '등급', '계약'],
    columns: [
      { name: 'land_name', type: 'VARCHAR', desc: '판매처명' },
      { name: 'sido', type: 'VARCHAR', desc: '시도' },
      { name: 'store_tier', type: 'VARCHAR', desc: '판매처 등급' },
      { name: 'contract_date', type: 'DATE', desc: '계약일' },
    ],
    rules: [
      '판매처는 고유 land_name으로 식별',
      '등급에 따라 노출 가중치 차등',
    ],
    recommendationScore: 2.1,
    updatedAt: '2026-04-10T00:00:00Z',
  },
  {
    key: 'product_master',
    description: '광고 상품 마스터 마트',
    keywords: ['상품', '광고', '단가', '카테고리', '브랜드'],
    columns: [
      { name: 'product_id', type: 'VARCHAR', desc: '광고 상품 ID' },
      { name: 'product_name', type: 'VARCHAR', desc: '상품명' },
      { name: 'category', type: 'VARCHAR', desc: '카테고리' },
      { name: 'unit_price', type: 'NUMBER', desc: '단가(원)' },
      { name: 'brand_name', type: 'VARCHAR', desc: '브랜드명' },
    ],
    rules: [
      '동일 상품은 전 지면 동일 단가',
      '단가는 월 단위 갱신',
    ],
    recommendationScore: 1.8,
    updatedAt: '2026-04-12T00:00:00Z',
  },
  {
    key: 'region_quota',
    description: '지역별 판매 상한 마트',
    keywords: ['상한', '캐파', '지역', '한도', '배정'],
    columns: [
      { name: 'sido', type: 'VARCHAR', desc: '시도' },
      { name: 'month', type: 'CHAR(7)', desc: 'YYYY-MM' },
      { name: 'quota_amount', type: 'NUMBER', desc: '배정 상한액(원)' },
      { name: 'actual_amount', type: 'NUMBER', desc: '실적액(원)' },
    ],
    rules: [
      '배정 상한 초과 시 추가 주문 불가',
      '월말 기준 재집계',
    ],
    recommendationScore: 1.5,
    updatedAt: '2026-04-01T00:00:00Z',
  },
  {
    key: 'ctr_benchmark',
    description: '카테고리별 CTR 벤치마크 마트',
    keywords: ['ctr', '클릭률', '벤치마크', '효율', '비교'],
    columns: [
      { name: 'category', type: 'VARCHAR', desc: '카테고리' },
      { name: 'sido', type: 'VARCHAR', desc: '시도' },
      { name: 'benchmark_ctr', type: 'FLOAT', desc: '벤치마크 CTR(%)' },
      { name: 'sample_size', type: 'NUMBER', desc: '표본 수' },
      { name: 'updated_month', type: 'CHAR(7)', desc: '기준월' },
    ],
    rules: ['분기별 갱신', '표본 100 미만 데이터는 제외'],
    recommendationScore: 1.2,
    updatedAt: '2026-03-31T00:00:00Z',
  },
  {
    key: 'daily_budget',
    description: '일별 예산 집행 현황 마트',
    keywords: ['예산', '집행', '소진', '잔여', '캠페인'],
    columns: [
      { name: 'budget_date', type: 'DATE', desc: '날짜' },
      { name: 'campaign_id', type: 'VARCHAR', desc: '캠페인 ID' },
      { name: 'daily_budget', type: 'NUMBER', desc: '일 예산(원)' },
      { name: 'spent_amount', type: 'NUMBER', desc: '집행액(원)' },
      { name: 'remaining', type: 'NUMBER', desc: '잔여액(원)' },
    ],
    rules: ['일 예산 초과 시 자동 중단', '캠페인-상품 N:M 관계'],
    recommendationScore: 0.9,
    updatedAt: '2026-04-18T00:00:00Z',
  },
]

export function scoreMarts(contextText: string, catalog: MartMeta[] = MART_CATALOG): MartMeta[] {
  if (!contextText.trim()) return catalog

  const lower = contextText.toLowerCase()
  return catalog.map((mart) => {
    let score = 0
    const searchFields = [
      mart.key,
      mart.description,
      ...mart.keywords,
      ...mart.columns.map((c) => `${c.name} ${c.desc}`),
    ].join(' ').toLowerCase()

    mart.keywords.forEach((kw) => {
      if (lower.includes(kw.toLowerCase())) score += 1
    })
    if (lower.includes(mart.key.toLowerCase())) score += 2
    if (searchFields.split(' ').some((w) => lower.includes(w) && w.length > 1)) score += 0.5

    return { ...mart, recommendationScore: score }
  }).sort((a, b) => (b.recommendationScore ?? 0) - (a.recommendationScore ?? 0))

}

export function searchMarts(query: string, marts: MartMeta[]): MartMeta[] {
  const q = query.trim().toLowerCase()
  if (!q) return marts

  // 매치 강도: key 정확(0) → key prefix(1) → key substring(2) → keyword(3)
  // → description(4) → column name(5) → column desc(6). 매치 없으면 제외.
  function rank(m: MartMeta): number {
    const key = m.key.toLowerCase()
    if (key === q) return 0
    if (key.startsWith(q)) return 1
    if (key.includes(q)) return 2
    if (m.keywords.some((k) => k.toLowerCase().includes(q))) return 3
    if (m.description.toLowerCase().includes(q)) return 4
    if (m.columns.some((c) => c.name.toLowerCase().includes(q))) return 5
    if (m.columns.some((c) => c.desc.toLowerCase().includes(q))) return 6
    return -1
  }

  return marts
    .map((m) => ({ m, r: rank(m) }))
    .filter(({ r }) => r >= 0)
    .sort((a, b) => a.r - b.r || a.m.key.localeCompare(b.m.key))
    .map(({ m }) => m)
}

import React, { useState, useRef } from 'react';
import { Settings, History, FileText, Plus, Play, Code, BarChart3, MessageSquare, Bot, ChevronRight, ChevronDown, ChevronUp, Database, Sparkles, Check, X, Trash2, Copy, Info, Zap, User, RotateCcw, Search, ArrowRight, ArrowUp, Compass, Pin, FileSearch, Layers, Wand2, Folder, FolderPlus, FolderOpen, MoreHorizontal } from 'lucide-react';

export default function VibeEDA() {
  const [agentMode, setAgentMode] = useState(false);
  const [analysisTheme, setAnalysisTheme] = useState('지역별 광고 매출 분석');
  const [analysisDescription, setAnalysisDescription] = useState('최근 7일간 시도/시군구 단위 광고 매출을 살펴보고, 지역별 판매 상한 대비 실적과 판매처(land_name)별 매출 분포를 확인한다. 특히 수도권 집중 현상과 비수도권 지면의 효율성을 비교해 상품 단가 및 지역 캐파 조정 방향을 탐색한다.');
  const [metaCollapsed, setMetaCollapsed] = useState(false);
  const [selectedMarts, setSelectedMarts] = useState(['ad_sales_mart']);
  const [martInfoExpanded, setMartInfoExpanded] = useState(null);
  const [martSearchQuery, setMartSearchQuery] = useState('');
  const [showReportModal, setShowReportModal] = useState(false);
  const [selectedCells, setSelectedCells] = useState({});
  const [generatingReport, setGeneratingReport] = useState(false);
  const [reportContent, setReportContent] = useState('');
  const [showReport, setShowReport] = useState(false);

  const [cells, setCells] = useState([
    {
      id: 'cell_1',
      name: 'daily_sales',
      type: 'sql',
      code: `SELECT\n  sale_date,\n  sido,\n  sigungu,\n  SUM(sales_amount) AS total_sales,\n  SUM(impressions) AS total_impressions\nFROM ad_sales_mart\nWHERE sale_date >= DATEADD(day, -7, CURRENT_DATE())\nGROUP BY sale_date, sido, sigungu\nORDER BY sale_date DESC\nLIMIT 100;`,
      activeTab: 'output',
      executed: true,
      output: 'table_daily_sales',
      chatInput: '',
      chatHistory: [
        { id: 1, user: '최근 30일 데이터를 시도/시군구별로 집계해줘', assistant: 'sale_date, sido, sigungu로 group by 하고 매출과 노출수를 합산하는 쿼리를 작성했어요.', timestamp: '09:12', codeSnapshot: `SELECT\n  sale_date,\n  sido,\n  sigungu,\n  SUM(sales_amount) AS total_sales,\n  SUM(impressions) AS total_impressions\nFROM ad_sales_mart\nWHERE sale_date >= DATEADD(day, -30, CURRENT_DATE())\nGROUP BY sale_date, sido, sigungu\nORDER BY sale_date DESC;` },
        { id: 2, user: '기간을 최근 7일로 줄여줘', assistant: 'DATEADD에서 -30을 -7로 변경했어요.', timestamp: '09:14', codeSnapshot: `SELECT\n  sale_date,\n  sido,\n  sigungu,\n  SUM(sales_amount) AS total_sales,\n  SUM(impressions) AS total_impressions\nFROM ad_sales_mart\nWHERE sale_date >= DATEADD(day, -7, CURRENT_DATE())\nGROUP BY sale_date, sido, sigungu\nORDER BY sale_date DESC;` },
        { id: 3, user: '상위 100개만 보이게', assistant: 'LIMIT 100을 추가했어요.', timestamp: '09:15', codeSnapshot: `SELECT\n  sale_date,\n  sido,\n  sigungu,\n  SUM(sales_amount) AS total_sales,\n  SUM(impressions) AS total_impressions\nFROM ad_sales_mart\nWHERE sale_date >= DATEADD(day, -7, CURRENT_DATE())\nGROUP BY sale_date, sido, sigungu\nORDER BY sale_date DESC\nLIMIT 100;` },
      ],
      historyOpen: false,
      insight: null,
    },
    {
      id: 'cell_2',
      name: 'sido_summary',
      type: 'sql',
      code: `SELECT\n  sido,\n  SUM(sales_amount) AS total_sales,\n  AVG(clicks::FLOAT / NULLIF(impressions, 0)) * 100 AS avg_ctr,\n  COUNT(DISTINCT land_name) AS store_count\nFROM ad_sales_mart\nWHERE sale_date >= DATEADD(day, -7, CURRENT_DATE())\nGROUP BY sido\nORDER BY total_sales DESC;`,
      activeTab: 'output',
      executed: true,
      output: 'table_sido_summary',
      chatInput: '',
      chatHistory: [
        { id: 1, user: '시도별로 총 매출이랑 평균 CTR 뽑아줘', assistant: 'sido 기준으로 group by 하고, 매출 합계와 impressions 대비 clicks 비율을 계산했어요.', timestamp: '09:18', codeSnapshot: `SELECT\n  sido,\n  SUM(sales_amount) AS total_sales,\n  AVG(clicks::FLOAT / NULLIF(impressions, 0)) * 100 AS avg_ctr\nFROM ad_sales_mart\nWHERE sale_date >= DATEADD(day, -7, CURRENT_DATE())\nGROUP BY sido\nORDER BY sido;` },
        { id: 2, user: '판매처 수도 함께 보여줘', assistant: 'COUNT(DISTINCT land_name)을 추가해서 시도별 판매처 수를 집계하도록 했어요.', timestamp: '09:21', codeSnapshot: `SELECT\n  sido,\n  SUM(sales_amount) AS total_sales,\n  AVG(clicks::FLOAT / NULLIF(impressions, 0)) * 100 AS avg_ctr,\n  COUNT(DISTINCT land_name) AS store_count\nFROM ad_sales_mart\nWHERE sale_date >= DATEADD(day, -7, CURRENT_DATE())\nGROUP BY sido\nORDER BY sido;` },
        { id: 3, user: '매출 높은 순으로 정렬', assistant: 'ORDER BY total_sales DESC로 정렬을 추가했어요.', timestamp: '09:22', codeSnapshot: `SELECT\n  sido,\n  SUM(sales_amount) AS total_sales,\n  AVG(clicks::FLOAT / NULLIF(impressions, 0)) * 100 AS avg_ctr,\n  COUNT(DISTINCT land_name) AS store_count\nFROM ad_sales_mart\nWHERE sale_date >= DATEADD(day, -7, CURRENT_DATE())\nGROUP BY sido\nORDER BY total_sales DESC;` },
      ],
      historyOpen: false,
      insight: null,
    },
    {
      id: 'cell_3',
      name: 'sido_sales_chart',
      type: 'python',
      code: `import plotly.express as px\nimport plotly.io as pio\n\npio.templates.default = "plotly_white"\n\nfig = px.bar(\n    sido_summary,\n    x='sido',\n    y='total_sales',\n    color='sido',\n    title='시도별 광고 매출 (최근 7일)',\n    labels={'total_sales': '매출액(원)', 'sido': '시도'}\n)\nfig.update_layout(\n    font=dict(family="Malgun Gothic", size=12),\n    showlegend=False\n)\nfig.show()`,
      activeTab: 'output',
      executed: true,
      output: 'chart_bar',
      chatInput: '',
      chatHistory: [
        { id: 1, user: 'sido_summary 데이터로 바 차트 그려줘', assistant: 'plotly.express로 sido별 total_sales 바 차트를 그렸어요.', timestamp: '09:25', codeSnapshot: `import plotly.express as px\n\nfig = px.bar(sido_summary, x='sido', y='total_sales', title='시도별 광고 매출')\nfig.show()` },
        { id: 2, user: '시도별로 색상 구분해줘', assistant: 'color 파라미터에 sido를 지정했어요.', timestamp: '09:27', codeSnapshot: `import plotly.express as px\n\nfig = px.bar(sido_summary, x='sido', y='total_sales', color='sido', title='시도별 광고 매출')\nfig.update_layout(showlegend=False)\nfig.show()` },
        { id: 3, user: '축 라벨 한글로 바꿔', assistant: 'labels 파라미터로 축 라벨을 한글화했어요.', timestamp: '09:28', codeSnapshot: `import plotly.express as px\nimport plotly.io as pio\n\npio.templates.default = "plotly_white"\n\nfig = px.bar(\n    sido_summary,\n    x='sido',\n    y='total_sales',\n    color='sido',\n    title='시도별 광고 매출 (최근 7일)',\n    labels={'total_sales': '매출액(원)', 'sido': '시도'}\n)\nfig.update_layout(\n    font=dict(family="Malgun Gothic", size=12),\n    showlegend=False\n)\nfig.show()` },
      ],
      historyOpen: false,
      insight: null,
    },
  ]);

  const [activeCellId, setActiveCellId] = useState('cell_1');
  const [rollbackToast, setRollbackToast] = useState(null);
  const [agentChatInput, setAgentChatInput] = useState('');
  const [agentChatHistory, setAgentChatHistory] = useState([]);
  const cellRefs = useRef({});

  // 히스토리 & 폴더 관리
  const [histories, setHistories] = useState([
    { id: 'h1', title: '지역별 광고 매출 분석', date: '오늘', folderId: null, isCurrent: true },
    { id: 'h2', title: '상품별 CTR 추이', date: '어제', folderId: 'f1', isCurrent: false },
    { id: 'h3', title: '판매처 랭킹 분석', date: '3일 전', folderId: 'f1', isCurrent: false },
    { id: 'h4', title: 'Q3 매출 요약', date: '1주일 전', folderId: 'f2', isCurrent: false },
    { id: 'h5', title: '신규 캠페인 분석', date: '2주일 전', folderId: null, isCurrent: false },
  ]);
  const [folders, setFolders] = useState([
    { id: 'f1', name: '지면 분석', isOpen: true },
    { id: 'f2', name: '월간 리포트', isOpen: false },
  ]);
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [historyMenuOpen, setHistoryMenuOpen] = useState(null);
  const [historyMenuView, setHistoryMenuView] = useState('main'); // 'main' | 'move'

  const mockTables = {
    table_daily_sales: {
      columns: ['sale_date', 'sido', 'sigungu', 'total_sales', 'total_impressions'],
      rows: [
        ['2026-04-17', '서울특별시', '강남구', 12500000, 450000],
        ['2026-04-17', '서울특별시', '서초구', 9800000, 380000],
        ['2026-04-17', '경기도', '성남시', 8200000, 320000],
        ['2026-04-16', '서울특별시', '강남구', 11800000, 442000],
        ['2026-04-16', '부산광역시', '해운대구', 6500000, 240000],
        ['2026-04-16', '경기도', '수원시', 7100000, 295000],
        ['2026-04-15', '서울특별시', '마포구', 5400000, 198000],
        ['2026-04-15', '인천광역시', '연수구', 4200000, 165000],
      ]
    },
    table_sido_summary: {
      columns: ['sido', 'total_sales', 'avg_ctr', 'store_count'],
      rows: [
        ['서울특별시', 145000000, 2.8, 42],
        ['경기도', 98000000, 2.4, 38],
        ['부산광역시', 52000000, 2.1, 18],
        ['인천광역시', 38000000, 2.0, 15],
        ['대구광역시', 28000000, 1.9, 12],
      ]
    }
  };

  const martMetadata = {
    ad_sales_mart: {
      description: '일별 광고 판매 집계 마트',
      keywords: ['매출', '판매', '광고', '지역', '시도', '시군구', 'ctr', '노출', '클릭', '수익'],
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
      rules: ['지역별 판매 상한선 존재', '동일 상품은 전 판매처 동일 단가', 'sale_date 기준 파티셔닝']
    },
    ad_inventory: {
      description: '광고 지면 재고 마트',
      keywords: ['재고', '지면', '인벤토리', '캐파', '가용', '슬롯', 'land_name'],
      columns: [
        { name: 'inventory_date', type: 'DATE', desc: '재고 기준일' },
        { name: 'land_name', type: 'VARCHAR', desc: '판매처/지면명' },
        { name: 'product_id', type: 'VARCHAR', desc: '상품 ID' },
        { name: 'total_capacity', type: 'NUMBER', desc: '총 재고 수량' },
        { name: 'remaining', type: 'NUMBER', desc: '잔여 재고' },
      ],
      rules: ['재고는 일자+지면+상품 단위', '잔여 0이면 판매 중단']
    },
    store_info: {
      description: '판매처 기본 정보 마트',
      keywords: ['판매처', '지면', '점포', '가맹', '등급', '계약', 'land_name'],
      columns: [
        { name: 'land_name', type: 'VARCHAR', desc: '판매처명' },
        { name: 'sido', type: 'VARCHAR', desc: '시도' },
        { name: 'store_tier', type: 'VARCHAR', desc: '판매처 등급' },
        { name: 'contract_date', type: 'DATE', desc: '계약일' },
      ],
      rules: ['판매처는 고유 land_name으로 식별', '등급에 따라 노출 가중치 차등']
    },
    product_master: {
      description: '광고 상품 마스터',
      keywords: ['상품', '단가', '가격', 'product', '카테고리'],
      columns: [
        { name: 'product_id', type: 'VARCHAR', desc: '상품 ID' },
        { name: 'product_name', type: 'VARCHAR', desc: '상품명' },
        { name: 'category', type: 'VARCHAR', desc: '카테고리' },
        { name: 'unit_price', type: 'NUMBER', desc: '기본 단가' },
      ],
      rules: ['상품 단가는 전 판매처 공통']
    },
    user_impression_log: {
      description: '사용자 노출 로그 (raw)',
      keywords: ['로그', '사용자', '노출', '클릭', '유저', 'user', '세션'],
      columns: [
        { name: 'log_time', type: 'TIMESTAMP', desc: '로그 발생 시각' },
        { name: 'user_id', type: 'VARCHAR', desc: '사용자 ID' },
        { name: 'product_id', type: 'VARCHAR', desc: '상품 ID' },
        { name: 'event_type', type: 'VARCHAR', desc: 'impression/click' },
      ],
      rules: ['대용량 — 기간 필터 필수', 'log_time 기준 파티셔닝']
    },
    region_cap: {
      description: '지역별 판매 상한 관리',
      keywords: ['상한', '캡', 'cap', '지역', '시도', '제한', '쿼터'],
      columns: [
        { name: 'effective_date', type: 'DATE', desc: '적용 시작일' },
        { name: 'sido', type: 'VARCHAR', desc: '시도' },
        { name: 'daily_cap_amount', type: 'NUMBER', desc: '일일 매출 상한' },
      ],
      rules: ['시도별 일일 상한 도달 시 판매 중단']
    }
  };

  const getRecommendedMarts = () => {
    const text = (analysisTheme + ' ' + analysisDescription).toLowerCase();
    const scored = Object.entries(martMetadata).map(([key, meta]) => {
      let score = 0;
      meta.keywords.forEach(kw => { if (text.includes(kw.toLowerCase())) score += 1; });
      meta.columns.forEach(col => { if (text.includes(col.name.toLowerCase())) score += 0.5; });
      return { key, meta, score };
    });
    return scored.sort((a, b) => b.score - a.score);
  };

  const recommendedMarts = getRecommendedMarts();
  const topRecommendation = recommendedMarts[0];

  const availableMarts = recommendedMarts.filter(r => {
    if (selectedMarts.includes(r.key)) return false;
    if (!martSearchQuery.trim()) return true;
    const q = martSearchQuery.toLowerCase();
    return r.key.toLowerCase().includes(q) || r.meta.description.toLowerCase().includes(q) ||
      r.meta.keywords.some(k => k.toLowerCase().includes(q)) ||
      r.meta.columns.some(c => c.name.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q));
  });

  const addMart = (martKey) => {
    if (!selectedMarts.includes(martKey)) setSelectedMarts([...selectedMarts, martKey]);
  };
  const removeMart = (martKey) => setSelectedMarts(selectedMarts.filter(k => k !== martKey));

  // 폴더 관리
  const createFolder = () => {
    if (!newFolderName.trim()) { setNewFolderMode(false); return; }
    const newFolder = {
      id: `f${Date.now()}`,
      name: newFolderName.trim(),
      isOpen: true,
    };
    setFolders([...folders, newFolder]);
    setNewFolderName('');
    setNewFolderMode(false);
  };

  const toggleFolder = (folderId) => {
    setFolders(folders.map(f => f.id === folderId ? { ...f, isOpen: !f.isOpen } : f));
  };

  const deleteFolder = (folderId) => {
    // 폴더 삭제 시 해당 폴더의 히스토리는 루트로 이동
    setHistories(histories.map(h => h.folderId === folderId ? { ...h, folderId: null } : h));
    setFolders(folders.filter(f => f.id !== folderId));
  };

  const moveHistoryToFolder = (historyId, folderId) => {
    setHistories(histories.map(h => h.id === historyId ? { ...h, folderId } : h));
    setHistoryMenuOpen(null);
    setHistoryMenuView('main');
  };

  const duplicateHistory = (historyId) => {
    const original = histories.find(h => h.id === historyId);
    if (!original) return;
    const newHistory = {
      id: `h${Date.now()}`,
      title: `${original.title} (복제)`,
      date: '방금 전',
      folderId: original.folderId,
      isCurrent: false,
    };
    // 원본 바로 다음 위치에 삽입
    const idx = histories.findIndex(h => h.id === historyId);
    const newHistories = [...histories.slice(0, idx + 1), newHistory, ...histories.slice(idx + 1)];
    setHistories(newHistories);
    setHistoryMenuOpen(null);
  };

  const deleteHistory = (historyId) => {
    setHistories(histories.filter(h => h.id !== historyId));
    setHistoryMenuOpen(null);
  };

  const openHistoryMenu = (historyId) => {
    if (historyMenuOpen === historyId) {
      setHistoryMenuOpen(null);
      setHistoryMenuView('main');
    } else {
      setHistoryMenuOpen(historyId);
      setHistoryMenuView('main');
    }
  };

  const cycleCellType = (cellId) => {
    const cycle = { sql: 'python', python: 'markdown', markdown: 'sql' };
    const cell = cells.find(c => c.id === cellId);
    if (!cell) return;
    const newType = cycle[cell.type] || 'sql';
    // 타입만 바꾸고 탭/코드는 그대로 유지. 마크다운은 항상 실행된 상태로 취급.
    updateCell(cellId, {
      type: newType,
      executed: newType === 'markdown' ? true : cell.executed,
      output: newType === 'markdown' ? 'markdown_render' : cell.output
    });
  };

  const scrollToCell = (cellId) => {
    cellRefs.current[cellId]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveCellId(cellId);
  };

  const rollbackToHistory = (cellId, historyId) => {
    const cell = cells.find(c => c.id === cellId);
    if (!cell) return;
    const entry = cell.chatHistory.find(h => h.id === historyId);
    if (!entry || !entry.codeSnapshot) return;
    updateCell(cellId, { code: entry.codeSnapshot, activeTab: 'code' });
    setActiveCellId(cellId);
    scrollToCell(cellId);
    setRollbackToast({ cellName: cell.name, timestamp: entry.timestamp });
    setTimeout(() => setRollbackToast(null), 3000);
    setTimeout(() => runCell(cellId), 400);
  };

  const addCell = (cellType) => {
    const existingNums = cells.map(c => parseInt(c.id.split('_')[1])).filter(n => !isNaN(n));
    const nextNum = existingNums.length ? Math.max(...existingNums) + 1 : 1;
    let newCode = '';
    let newName = '';
    if (cellType === 'sql') {
      newName = `query_${nextNum}`;
      newCode = `-- 새 쿼리\nSELECT * FROM ${selectedMarts[0] || 'ad_sales_mart'}\nLIMIT 100;`;
    } else if (cellType === 'python') {
      newName = `chart_${nextNum}`;
      newCode = `import plotly.express as px\n\nfig = px.bar(df, x='sido', y='total_sales', title='시도별 매출')\nfig.update_layout(font=dict(family="Malgun Gothic"))\nfig.show()`;
    } else {
      newName = `note_${nextNum}`;
      newCode = `# 새 노트\n\n여기에 분석 맥락, 발견 사항, 다음 단계를 기록해보세요.\n\n- 항목 1\n- 항목 2`;
    }
    const newCell = {
      id: `cell_${nextNum}`,
      name: newName,
      type: cellType,
      code: newCode,
      activeTab: cellType === 'markdown' ? 'output' : 'code',
      executed: cellType === 'markdown',
      output: cellType === 'markdown' ? 'markdown_render' : null,
      chatInput: '',
      chatHistory: [],
      historyOpen: false,
      insight: null,
    };
    const activeIdx = cells.findIndex(c => c.id === activeCellId);
    let newCells;
    if (activeIdx === -1) {
      newCells = [...cells, newCell];
    } else {
      newCells = [...cells.slice(0, activeIdx + 1), newCell, ...cells.slice(activeIdx + 1)];
    }
    setCells(newCells);
    setActiveCellId(newCell.id);
    setTimeout(() => scrollToCell(newCell.id), 100);
  };

  const deleteCell = (cellId) => setCells(cells.filter(c => c.id !== cellId));
  const updateCell = (cellId, updates) => setCells(cells.map(c => c.id === cellId ? { ...c, ...updates } : c));

  const runCell = (cellId) => {
    const cell = cells.find(c => c.id === cellId);
    if (!cell) return;
    let output;
    if (cell.type === 'sql') {
      output = cell.code.toLowerCase().includes('group by sido') && !cell.code.toLowerCase().includes('sigungu')
        ? 'table_sido_summary' : 'table_daily_sales';
    } else {
      output = 'chart_bar';
    }
    updateCell(cellId, { executed: true, output, activeTab: 'output' });
    if (agentMode) {
      setTimeout(() => {
        const insight = cell.type === 'sql'
          ? '서울특별시 강남구의 매출이 전체의 약 40%를 차지합니다. 시도별 집계를 추가로 보는 것이 좋겠습니다.'
          : '시각화된 패턴에서 서울 강남 지역의 매출 집중 현상이 뚜렷합니다.';
        updateCell(cellId, { insight });
      }, 600);
    }
  };

  const handleChatSubmit = (cellId) => {
    const cell = cells.find(c => c.id === cellId);
    if (!cell || !cell.chatInput.trim()) return;
    const userMessage = cell.chatInput;
    const input = userMessage.toLowerCase();
    let newCode = cell.code;
    let assistantReply = '';
    if (cell.type === 'sql') {
      if (input.includes('시도') && input.includes('group')) {
        newCode = `SELECT\n  sido,\n  SUM(sales_amount) AS total_sales\nFROM ${selectedMarts[0] || 'ad_sales_mart'}\nGROUP BY sido\nORDER BY total_sales DESC;`;
        assistantReply = '시도 기준으로 집계하도록 쿼리를 수정했어요.';
      } else if (input.includes('7일')) {
        newCode = cell.code.replace(/-30/g, '-7');
        assistantReply = '기간을 최근 7일로 변경했어요.';
      } else {
        newCode = cell.code + `\n-- 요청: ${userMessage}`;
        assistantReply = '요청을 주석으로 추가했어요.';
      }
    } else {
      if (input.includes('pie')) {
        newCode = cell.code.replace('px.bar', 'px.pie');
        assistantReply = '파이 차트로 변경했어요.';
      } else {
        newCode = cell.code + `\n# 요청: ${userMessage}`;
        assistantReply = '요청을 주석으로 추가했어요.';
      }
    }
    const newEntry = {
      id: Date.now(),
      user: userMessage,
      assistant: assistantReply,
      timestamp: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
      codeSnapshot: newCode,
    };
    updateCell(cellId, { code: newCode, chatInput: '', activeTab: 'code', chatHistory: [...(cell.chatHistory || []), newEntry], historyOpen: true });
    setTimeout(() => runCell(cellId), 300);
  };

  const handleAgentChatSubmit = () => {
    if (!agentChatInput.trim()) return;
    const userMsg = agentChatInput;
    const input = userMsg.toLowerCase();
    const timestamp = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    let reply = '';
    let createdCells = [];
    if (input.includes('강남') || input.includes('세부')) {
      reply = '강남구 내부의 세부 매출 패턴을 살펴보기 위해 판매처별 집계 셀을 추가했어요.';
      const existingNums = cells.map(c => parseInt(c.id.split('_')[1])).filter(n => !isNaN(n));
      const nextNum = existingNums.length ? Math.max(...existingNums) + 1 : 1;
      createdCells.push({
        id: `agent_chat_${nextNum}`,
        name: 'gangnam_lands',
        type: 'sql',
        code: `SELECT land_name, SUM(sales_amount) AS total_sales\nFROM ${selectedMarts[0] || 'ad_sales_mart'}\nWHERE sigungu = '강남구'\nGROUP BY land_name\nORDER BY total_sales DESC\nLIMIT 20;`,
        activeTab: 'output',
        executed: true,
        output: 'table_daily_sales',
        chatInput: '',
        chatHistory: [],
        historyOpen: false,
        insight: null,
        agentGenerated: true,
      });
    } else if (input.includes('요약') || input.includes('인사이트')) {
      reply = '현재까지의 분석을 종합하면 서울 강남/서초가 매출 상위권이며, 수도권 외 지역은 CTR은 안정적이나 절대 노출량이 낮습니다.';
    } else {
      reply = '좀 더 구체적으로 말씀해주시면 도움이 됩니다 — 예: "강남구 세부 분석", "전체 인사이트 요약".';
    }
    setAgentChatHistory(prev => [...prev,
      { id: Date.now(), role: 'user', content: userMsg, timestamp },
      { id: Date.now() + 1, role: 'assistant', content: reply, timestamp, createdCellIds: createdCells.map(c => c.id) }
    ]);
    if (createdCells.length > 0) {
      setCells(prev => [...prev, ...createdCells]);
      setTimeout(() => scrollToCell(createdCells[0].id), 300);
    }
    setAgentChatInput('');
  };

  const openReportModal = () => {
    const initial = {};
    cells.forEach(c => { if (c.executed) initial[c.id] = true; });
    setSelectedCells(initial);
    setShowReportModal(true);
  };

  const generateReport = () => {
    setGeneratingReport(true);
    setShowReportModal(false);
    setTimeout(() => {
      const selected = cells.filter(c => selectedCells[c.id]);
      const now = new Date().toISOString().split('T')[0];
      let md = `# ${analysisTheme}\n\n`;
      md += `> 분석일자: ${now}  \n> 사용 마트 (${selectedMarts.length}): ${selectedMarts.map(m => `\`${m}\``).join(', ')}  \n> 포함 셀: ${selected.length}개\n\n`;
      if (analysisDescription) md += `## 분석 배경\n\n${analysisDescription}\n\n`;
      md += `---\n\n## 분석 내용\n\n`;
      selected.forEach((cell, idx) => {
        md += `### ${idx + 1}. \`${cell.name}\`\n\n`;
        md += `\`\`\`${cell.type === 'sql' ? 'sql' : cell.type}\n${cell.code}\n\`\`\`\n\n`;
        if (cell.output && mockTables[cell.output]) {
          const t = mockTables[cell.output];
          md += `| ${t.columns.join(' | ')} |\n| ${t.columns.map(() => '---').join(' | ')} |\n`;
          t.rows.slice(0, 3).forEach(r => { md += `| ${r.join(' | ')} |\n`; });
          md += `\n`;
        }
      });
      md += `---\n\n*Vibe EDA로 자동 생성된 초안입니다.*\n`;
      setReportContent(md);
      setGeneratingReport(false);
      setShowReport(true);
    }, 1500);
  };

  const renderTable = (tableKey) => {
    const t = mockTables[tableKey];
    if (!t) return <div className="text-stone-500 text-sm p-4">출력 결과 없음</div>;
    return (
      <div className="overflow-auto hide-scrollbar" style={{maxHeight: '340px'}}>
        <table className="text-xs" style={{minWidth: '100%'}}>
          <thead className="sticky top-0" style={{backgroundColor: '#faf8f2'}}>
            <tr>
              {t.columns.map((c, i) => (
                <th key={i} className="py-3 text-left font-semibold text-stone-700 border-b border-stone-200 whitespace-nowrap"
                  style={{ paddingLeft: i === 0 ? '20px' : '16px', paddingRight: i === t.columns.length - 1 ? '20px' : '16px' }}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((r, i) => (
              <tr key={i} className="border-b border-stone-100 hover:bg-stone-50/60 transition-colors">
                {r.map((cell, j) => (
                  <td key={j} className="py-2.5 text-stone-600 font-mono whitespace-nowrap"
                    style={{ paddingLeft: j === 0 ? '20px' : '16px', paddingRight: j === r.length - 1 ? '20px' : '16px' }}>
                    {typeof cell === 'number' ? cell.toLocaleString() : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="text-[10px] text-stone-400 py-2.5 sticky bottom-0" style={{backgroundColor: '#faf8f2', paddingLeft: '20px', paddingRight: '20px'}}>
          {t.rows.length} rows × {t.columns.length} columns
        </div>
      </div>
    );
  };

  const renderMarkdown = (src) => {
    const lines = src.split('\n');
    const elements = [];
    let listBuffer = [];
    const flushList = () => {
      if (listBuffer.length > 0) {
        elements.push(<ul key={`ul-${elements.length}`} className="list-disc list-inside space-y-0.5 text-sm text-stone-700 my-2">{listBuffer.map((it, i) => <li key={i}>{it}</li>)}</ul>);
        listBuffer = [];
      }
    };
    lines.forEach((line, i) => {
      if (line.startsWith('# ')) { flushList(); elements.push(<h1 key={i} className="text-lg font-bold text-stone-900 mt-3 mb-2">{line.slice(2)}</h1>); }
      else if (line.startsWith('## ')) { flushList(); elements.push(<h2 key={i} className="text-base font-semibold text-stone-900 mt-3 mb-1.5">{line.slice(3)}</h2>); }
      else if (line.startsWith('### ')) { flushList(); elements.push(<h3 key={i} className="text-sm font-semibold text-stone-800 mt-2 mb-1">{line.slice(4)}</h3>); }
      else if (line.startsWith('- ') || line.startsWith('* ')) { listBuffer.push(line.slice(2)); }
      else if (line.trim() === '') { flushList(); }
      else {
        flushList();
        const html = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code style="background:#f5f4ed;padding:1px 4px;border-radius:3px;font-family:monospace;font-size:0.85em">$1</code>');
        elements.push(<p key={i} className="text-sm text-stone-700 my-1.5 leading-relaxed" dangerouslySetInnerHTML={{__html: html}} />);
      }
    });
    flushList();
    return <div className="px-6 py-4">{elements.length > 0 ? elements : <div className="text-stone-400 text-xs text-center py-8">내용을 입력하세요</div>}</div>;
  };

  const renderChart = () => (
    <div className="p-6" style={{backgroundColor: '#faf8f2'}}>
      <div className="text-xs font-semibold text-stone-700 mb-3">시도별 매출 (Plotly)</div>
      <svg viewBox="0 0 500 260" className="w-full">
        <g>
          {[
            { label: '서울', val: 145, color: '#D95C3F' },
            { label: '경기', val: 98, color: '#E08A4F' },
            { label: '부산', val: 52, color: '#B87333' },
            { label: '인천', val: 38, color: '#8B5A3C' },
            { label: '대구', val: 28, color: '#6b4423' },
          ].map((d, i) => {
            const barH = (d.val / 150) * 180;
            const x = 60 + i * 85;
            return (
              <g key={i}>
                <rect x={x} y={220 - barH} width="55" height={barH} fill={d.color} rx="4" />
                <text x={x + 27.5} y={240} textAnchor="middle" fontSize="11" fill="#57534e">{d.label}</text>
                <text x={x + 27.5} y={215 - barH} textAnchor="middle" fontSize="10" fill="#78716c" fontWeight="600">{d.val}M</text>
              </g>
            );
          })}
          <line x1="40" y1="220" x2="480" y2="220" stroke="#e7e5e0" strokeWidth="1" />
        </g>
      </svg>
    </div>
  );

  const typeColors = (type) => ({
    backgroundColor: type === 'sql' ? '#e8e4d8' : type === 'python' ? '#e6ede0' : '#eae4df',
    color: type === 'sql' ? '#5c4a1e' : type === 'python' ? '#3d5226' : '#4a3c2e'
  });
  const typeLabel = (type) => type === 'markdown' ? 'MD' : type.toUpperCase();

  return (
    <div className="h-screen flex text-stone-800 text-sm overflow-hidden" style={{fontFamily: "'Pretendard', -apple-system, 'Malgun Gothic', sans-serif", backgroundColor: '#faf9f5'}}>
      <style>{`
        .hide-scrollbar { scrollbar-width: none; -ms-overflow-style: none; }
        .hide-scrollbar::-webkit-scrollbar { display: none; width: 0; height: 0; }
      `}</style>

      {/* 좌측 사이드바 */}
      <aside className="w-56 border-r border-stone-200 flex flex-col shrink-0" style={{backgroundColor: '#f5f4ed'}}>
        <div className="h-14 px-4 border-b border-stone-200 flex items-center shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{backgroundColor: '#D95C3F'}}>
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="font-semibold text-stone-900 leading-tight">Vibe EDA</div>
              <div className="text-[10px] text-stone-500 leading-tight">분석가용 AI EDA</div>
            </div>
          </div>
        </div>

        <div className="px-3 py-3 border-b border-stone-200">
          <div className="flex items-center gap-2 text-xs font-semibold text-stone-500 uppercase tracking-wide mb-2 px-2">
            <Settings className="w-3 h-3" /> 설정
          </div>
          <button className="w-full text-left px-3 py-2 rounded hover:bg-stone-200/60 text-stone-700 text-xs flex items-center gap-2">
            <Database className="w-3.5 h-3.5" /> 연결 관리
          </button>
          <button className="w-full text-left px-3 py-2 rounded hover:bg-stone-200/60 text-stone-700 text-xs flex items-center gap-2">
            <Bot className="w-3.5 h-3.5" /> 모델 설정
          </button>
        </div>

        <div className="px-3 py-3 flex-1 overflow-auto hide-scrollbar">
          <div className="flex items-center justify-between mb-2 px-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-stone-500 uppercase tracking-wide">
              <History className="w-3 h-3" /> 히스토리
            </div>
            <button
              onClick={() => setNewFolderMode(true)}
              className="p-1 rounded hover:bg-stone-200/60 text-stone-500 hover:text-stone-700 transition-colors"
              title="폴더 만들기"
            >
              <FolderPlus className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* 새 폴더 입력창 */}
          {newFolderMode && (
            <div className="mb-2 px-2 py-1.5 rounded border bg-white flex items-center gap-1.5" style={{borderColor: '#ebc2b5'}}>
              <Folder className="w-3.5 h-3.5 shrink-0" style={{color: '#D95C3F'}} />
              <input
                type="text"
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') createFolder();
                  if (e.key === 'Escape') { setNewFolderMode(false); setNewFolderName(''); }
                }}
                placeholder="폴더 이름"
                autoFocus
                className="flex-1 text-xs bg-transparent focus:outline-none text-stone-800 placeholder-stone-400 min-w-0"
              />
              <button onClick={createFolder} className="text-[10px] font-semibold shrink-0" style={{color: '#D95C3F'}}>추가</button>
              <button onClick={() => { setNewFolderMode(false); setNewFolderName(''); }} className="text-stone-400 hover:text-stone-600 shrink-0">
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* 폴더 목록 */}
          {folders.map(folder => {
            const folderHistories = histories.filter(h => h.folderId === folder.id);
            return (
              <div key={folder.id} className="mb-1">
                <div className="group flex items-center gap-1 px-2 py-1.5 rounded hover:bg-stone-200/40 transition-colors">
                  <button onClick={() => toggleFolder(folder.id)} className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
                    {folder.isOpen 
                      ? <ChevronDown className="w-3 h-3 text-stone-400 shrink-0" /> 
                      : <ChevronRight className="w-3 h-3 text-stone-400 shrink-0" />
                    }
                    {folder.isOpen 
                      ? <FolderOpen className="w-3.5 h-3.5 shrink-0" style={{color: '#D95C3F'}} /> 
                      : <Folder className="w-3.5 h-3.5 shrink-0" style={{color: '#D95C3F'}} />
                    }
                    <span className="text-xs font-semibold text-stone-700 truncate">{folder.name}</span>
                    <span className="text-[10px] text-stone-400 shrink-0">{folderHistories.length}</span>
                  </button>
                  <button
                    onClick={() => deleteFolder(folder.id)}
                    className="p-0.5 rounded text-stone-400 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all"
                    title="폴더 삭제"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>

                {folder.isOpen && (
                  <div className="ml-3 pl-2 border-l border-stone-200 space-y-0.5 mt-0.5">
                    {folderHistories.length === 0 ? (
                      <div className="text-[10px] text-stone-400 italic px-2 py-1">비어있음</div>
                    ) : (
                      folderHistories.map(h => (
                        <div key={h.id} className="group relative">
                          <div className={`flex items-center gap-1 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                            h.isCurrent ? 'border' : 'hover:bg-stone-200/40'
                          }`}
                          style={h.isCurrent ? {backgroundColor: '#fff', borderColor: '#ebc2b5'} : {}}
                          >
                            <div className="flex-1 min-w-0">
                              <div className="text-xs truncate" style={{
                                color: h.isCurrent ? '#8f3a22' : '#57534e',
                                fontWeight: h.isCurrent ? 600 : 400
                              }}>{h.title}</div>
                              <div className="text-[10px] mt-0.5" style={{color: h.isCurrent ? '#D95C3F' : '#a8a29e'}}>{h.date}</div>
                            </div>
                            <button
                              onClick={(e) => { e.stopPropagation(); openHistoryMenu(h.id); }}
                              className="p-0.5 rounded text-stone-400 hover:text-stone-700 hover:bg-stone-200/60 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                            >
                              <MoreHorizontal className="w-3 h-3" />
                            </button>
                          </div>
                          {historyMenuOpen === h.id && (
                            <div className="absolute right-0 top-full mt-0.5 z-20 rounded-md shadow-lg border py-1 min-w-[140px]" style={{backgroundColor: '#fff', borderColor: '#e7e5e0'}}>
                              {historyMenuView === 'main' ? (
                                <>
                                  <button onClick={() => setHistoryMenuView('move')} className="w-full text-left px-3 py-1.5 text-[11px] text-stone-700 hover:bg-stone-100 flex items-center justify-between">
                                    <span className="flex items-center gap-1.5"><Folder className="w-3 h-3" /> 이동</span>
                                    <ChevronRight className="w-3 h-3 text-stone-400" />
                                  </button>
                                  <button onClick={() => duplicateHistory(h.id)} className="w-full text-left px-3 py-1.5 text-[11px] text-stone-700 hover:bg-stone-100 flex items-center gap-1.5">
                                    <Copy className="w-3 h-3" /> 복제
                                  </button>
                                  <div className="my-0.5 border-t border-stone-100"></div>
                                  <button onClick={() => deleteHistory(h.id)} className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-red-50 flex items-center gap-1.5" style={{color: '#dc2626'}}>
                                    <Trash2 className="w-3 h-3" /> 삭제
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button onClick={() => setHistoryMenuView('main')} className="w-full text-left px-3 py-1.5 text-[10px] font-semibold text-stone-500 hover:bg-stone-50 flex items-center gap-1">
                                    <ChevronRight className="w-3 h-3 rotate-180" /> 이동할 위치
                                  </button>
                                  <div className="border-t border-stone-100 my-0.5"></div>
                                  <button onClick={() => moveHistoryToFolder(h.id, null)} className="w-full text-left px-3 py-1.5 text-[11px] text-stone-700 hover:bg-stone-100 flex items-center gap-1.5">
                                    <History className="w-3 h-3" /> 루트
                                    {h.folderId === null && <Check className="w-3 h-3 ml-auto" style={{color: '#D95C3F'}} />}
                                  </button>
                                  {folders.map(f => (
                                    <button key={f.id} onClick={() => moveHistoryToFolder(h.id, f.id)} className="w-full text-left px-3 py-1.5 text-[11px] text-stone-700 hover:bg-stone-100 flex items-center gap-1.5">
                                      <Folder className="w-3 h-3" /> {f.name}
                                      {h.folderId === f.id && <Check className="w-3 h-3 ml-auto" style={{color: '#D95C3F'}} />}
                                    </button>
                                  ))}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* 루트(폴더에 없는) 히스토리 */}
          <div className="space-y-0.5 mt-1">
            {histories.filter(h => h.folderId === null).map(h => (
              <div key={h.id} className="group relative">
                <div className={`flex items-center gap-1 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                  h.isCurrent ? 'border' : 'hover:bg-stone-200/40'
                }`}
                style={h.isCurrent ? {backgroundColor: '#fff', borderColor: '#ebc2b5'} : {}}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs truncate" style={{
                      color: h.isCurrent ? '#8f3a22' : '#57534e',
                      fontWeight: h.isCurrent ? 600 : 400
                    }}>{h.title}</div>
                    <div className="text-[10px] mt-0.5" style={{color: h.isCurrent ? '#D95C3F' : '#a8a29e'}}>{h.date}</div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); openHistoryMenu(h.id); }}
                    className="p-0.5 rounded text-stone-400 hover:text-stone-700 hover:bg-stone-200/60 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                  >
                    <MoreHorizontal className="w-3 h-3" />
                  </button>
                </div>
                {historyMenuOpen === h.id && (
                  <div className="absolute right-0 top-full mt-0.5 z-20 rounded-md shadow-lg border py-1 min-w-[140px]" style={{backgroundColor: '#fff', borderColor: '#e7e5e0'}}>
                    {historyMenuView === 'main' ? (
                      <>
                        <button onClick={() => setHistoryMenuView('move')} className="w-full text-left px-3 py-1.5 text-[11px] text-stone-700 hover:bg-stone-100 flex items-center justify-between">
                          <span className="flex items-center gap-1.5"><Folder className="w-3 h-3" /> 이동</span>
                          <ChevronRight className="w-3 h-3 text-stone-400" />
                        </button>
                        <button onClick={() => duplicateHistory(h.id)} className="w-full text-left px-3 py-1.5 text-[11px] text-stone-700 hover:bg-stone-100 flex items-center gap-1.5">
                          <Copy className="w-3 h-3" /> 복제
                        </button>
                        <div className="my-0.5 border-t border-stone-100"></div>
                        <button onClick={() => deleteHistory(h.id)} className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-red-50 flex items-center gap-1.5" style={{color: '#dc2626'}}>
                          <Trash2 className="w-3 h-3" /> 삭제
                        </button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => setHistoryMenuView('main')} className="w-full text-left px-3 py-1.5 text-[10px] font-semibold text-stone-500 hover:bg-stone-50 flex items-center gap-1">
                          <ChevronRight className="w-3 h-3 rotate-180" /> 이동할 위치
                        </button>
                        <div className="border-t border-stone-100 my-0.5"></div>
                        <button onClick={() => moveHistoryToFolder(h.id, null)} className="w-full text-left px-3 py-1.5 text-[11px] text-stone-700 hover:bg-stone-100 flex items-center gap-1.5">
                          <History className="w-3 h-3" /> 루트
                          {h.folderId === null && <Check className="w-3 h-3 ml-auto" style={{color: '#D95C3F'}} />}
                        </button>
                        {folders.length === 0 ? (
                          <div className="px-3 py-1.5 text-[10px] text-stone-400 italic">폴더를 먼저 만드세요</div>
                        ) : (
                          folders.map(f => (
                            <button key={f.id} onClick={() => moveHistoryToFolder(h.id, f.id)} className="w-full text-left px-3 py-1.5 text-[11px] text-stone-700 hover:bg-stone-100 flex items-center gap-1.5">
                              <Folder className="w-3 h-3" /> {f.name}
                              {h.folderId === f.id && <Check className="w-3 h-3 ml-auto" style={{color: '#D95C3F'}} />}
                            </button>
                          ))
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="px-3 py-3 border-t border-stone-200">
          <div className="flex items-center gap-2 px-2">
            <div className="w-6 h-6 rounded-full" style={{background: 'linear-gradient(135deg, #ebc2b5, #D95C3F)'}}></div>
            <div className="text-xs text-stone-700">하우</div>
          </div>
        </div>
      </aside>

      {/* 중앙 + 우측 통합 */}
      <div className="flex-1 flex flex-col overflow-hidden border-l border-stone-200" style={{backgroundColor: '#fdfcf8'}}>

        {/* 상단 메타 */}
        <div className="bg-white border-b border-stone-200 shrink-0">
          <div className="w-full h-14 px-6 flex items-center gap-3 text-left">
            <button onClick={() => setMetaCollapsed(!metaCollapsed)} className="p-1 -ml-1 rounded hover:bg-stone-100 transition-colors shrink-0">
              {metaCollapsed ? <ChevronRight className="w-4 h-4 text-stone-400" /> : <ChevronDown className="w-4 h-4 text-stone-400" />}
            </button>
            <Pin className="w-3.5 h-3.5 text-stone-400 shrink-0" strokeWidth={2} />
            <div className="flex-1 font-semibold text-stone-900 truncate min-w-0">
              {metaCollapsed ? (
                <button onClick={() => setMetaCollapsed(false)} className="w-full text-left truncate hover:text-stone-700 transition-colors">{analysisTheme}</button>
              ) : (
                <input type="text" value={analysisTheme} onChange={e => setAnalysisTheme(e.target.value)} className="w-full bg-transparent font-semibold text-stone-900 border-none focus:outline-none focus:ring-0 p-0" placeholder="한 줄로 주제를 입력하세요" />
              )}
            </div>
            <button onClick={openReportModal} className="px-3 py-1.5 text-white text-xs font-semibold rounded-lg transition-all flex items-center gap-1.5 shadow-sm hover:shadow-md shrink-0"
              style={{backgroundColor: '#D95C3F'}}
              onMouseEnter={e => e.currentTarget.style.backgroundColor = '#C24E34'}
              onMouseLeave={e => e.currentTarget.style.backgroundColor = '#D95C3F'}>
              <FileText className="w-3.5 h-3.5" /> 리포팅
            </button>
          </div>

          {!metaCollapsed && (
            <div className="px-6 pb-4 border-t border-stone-100">
              <div className="grid grid-cols-2 gap-4 pt-3">
                {/* 왼쪽: 분석 내용 */}
                <div className="flex flex-col">
                  <label className="text-[10px] font-semibold text-stone-500 uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
                    <FileSearch className="w-3 h-3" strokeWidth={2} />
                    분석 내용 <span className="text-stone-400 normal-case font-normal">· 상세할수록 좋은 마트를 추천받을 수 있어요</span>
                  </label>
                  <textarea value={analysisDescription} onChange={e => setAnalysisDescription(e.target.value)}
                    className="w-full px-3 py-2 border border-stone-200 rounded text-sm focus:outline-none resize-none leading-relaxed flex-1"
                    style={{minHeight: '260px'}}
                    onFocus={e => { e.target.style.borderColor = '#D95C3F'; e.target.style.boxShadow = '0 0 0 2px #f8e5dd'; }}
                    onBlur={e => { e.target.style.borderColor = ''; e.target.style.boxShadow = ''; }}
                    placeholder="무엇을, 어떤 관점에서, 왜 분석하려고 하는지 구체적으로 적어주세요." />
                </div>

                {/* 오른쪽: 사용 마트 */}
                <div className="flex flex-col">
                  <label className="text-[10px] font-semibold text-stone-500 uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
                    <Layers className="w-3 h-3" strokeWidth={2} />
                    사용 마트 <span className="text-stone-400 normal-case font-normal">· 좌측에서 고르면 우측으로 추가돼요</span>
                  </label>

                  <div className="grid grid-cols-2 gap-2 flex-1" style={{minHeight: '260px'}}>
                    <div className="border border-stone-200 rounded-lg overflow-hidden flex flex-col" style={{backgroundColor: '#faf9f5'}}>
                      <div className="p-2 border-b border-stone-200 bg-white">
                        <div className="relative">
                          <Search className="w-3.5 h-3.5 text-stone-400 absolute left-2 top-1/2 -translate-y-1/2" />
                          <input type="text" value={martSearchQuery} onChange={e => setMartSearchQuery(e.target.value)} placeholder="마트명, 컬럼 검색..."
                            className="w-full pl-7 pr-7 py-1.5 text-[11px] border border-stone-200 rounded focus:outline-none"
                            onFocus={e => { e.target.style.borderColor = '#D95C3F'; }}
                            onBlur={e => { e.target.style.borderColor = ''; }} />
                          {martSearchQuery && (
                            <button onClick={() => setMartSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600"><X className="w-3 h-3" /></button>
                          )}
                        </div>
                      </div>
                      <div className="flex-1 overflow-auto hide-scrollbar p-1.5">
                        {availableMarts.length === 0 ? (
                          <div className="text-[11px] text-stone-400 text-center py-6 px-2">
                            {martSearchQuery ? `"${martSearchQuery}"에 맞는 마트가 없어요` : '모든 마트를 사용 중이에요'}
                          </div>
                        ) : (
                          <>
                            {!martSearchQuery && availableMarts.some(r => r.score > 0) && (
                              <div className="px-1.5 py-1 text-[9px] font-semibold uppercase tracking-wide flex items-center gap-1" style={{color: '#8f3a22'}}>
                                <Sparkles className="w-2.5 h-2.5" /> 분석 내용 기반 추천
                              </div>
                            )}
                            {availableMarts.map((rec, i) => {
                              const isRecommended = rec.score > 0 && !martSearchQuery;
                              const isTopRec = i === 0 && rec.score > 0 && !martSearchQuery;
                              const isExpanded = martInfoExpanded === rec.key;
                              return (
                                <div key={rec.key} className="rounded mb-1 transition-all border"
                                  style={{ backgroundColor: isRecommended ? '#fdf6ed' : '#fff', borderColor: isRecommended ? '#f0d9b5' : '#e7e5e0' }}>
                                  <div className="flex items-center gap-1 p-1.5">
                                    <button onClick={() => addMart(rec.key)} className="flex-1 min-w-0 text-left flex items-center gap-1.5">
                                      {isTopRec && <Sparkles className="w-2.5 h-2.5 shrink-0" strokeWidth={2.5} style={{color: '#d97706'}} />}
                                      <Database className="w-3 h-3 text-stone-400 shrink-0" />
                                      <span className="text-[11px] font-mono font-semibold text-stone-800 truncate">{rec.key}</span>
                                      {isRecommended && (
                                        <span className="text-[8px] px-1 py-0.5 rounded font-semibold shrink-0" style={{backgroundColor: '#fef3c7', color: '#92400e'}}>{rec.score.toFixed(1)}</span>
                                      )}
                                    </button>
                                    <button onClick={() => setMartInfoExpanded(isExpanded ? null : rec.key)} className="p-0.5 text-stone-400 shrink-0 hover:text-stone-600" title="상세 정보">
                                      {isExpanded ? <ChevronUp className="w-3 h-3" /> : <Info className="w-3 h-3" />}
                                    </button>
                                    <button onClick={() => addMart(rec.key)} className="p-0.5 rounded shrink-0" style={{color: '#D95C3F'}} title="추가">
                                      <Plus className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                  <div className="px-2 pb-1 text-[10px] text-stone-500 truncate">{rec.meta.description}</div>
                                  {isExpanded && (
                                    <div className="px-2 pb-2 pt-1 border-t border-stone-100 bg-white/70">
                                      <div className="space-y-0.5 mb-2">
                                        {rec.meta.columns.map((c, ci) => (
                                          <div key={ci} className="text-[10px] flex gap-1.5">
                                            <span className="font-mono font-semibold shrink-0" style={{color: '#D95C3F'}}>{c.name}</span>
                                            <span className="text-stone-500 truncate">{c.desc}</span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </>
                        )}
                      </div>
                    </div>

                    <div className="rounded-lg overflow-hidden flex flex-col border" style={{backgroundColor: '#fdede8', borderColor: '#ebc2b5'}}>
                      <div className="px-3 py-2 border-b bg-white flex items-center justify-between" style={{borderColor: '#ebc2b5'}}>
                        <div className="flex items-center gap-1.5">
                          <Check className="w-3.5 h-3.5" style={{color: '#D95C3F'}} />
                          <span className="text-[11px] font-semibold" style={{color: '#8f3a22'}}>사용할 마트</span>
                        </div>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{backgroundColor: '#fdede8', color: '#8f3a22'}}>{selectedMarts.length}개</span>
                      </div>
                      <div className="flex-1 overflow-auto hide-scrollbar p-1.5">
                        {selectedMarts.length === 0 ? (
                          <div className="text-[11px] text-stone-400 text-center py-6 px-2">
                            <ArrowRight className="w-5 h-5 mx-auto mb-2 text-stone-300" />
                            좌측에서 사용할 마트를 추가하세요
                          </div>
                        ) : (
                          selectedMarts.map(mk => {
                            const meta = martMetadata[mk];
                            if (!meta) return null;
                            return (
                              <div key={mk} className="rounded mb-1 bg-white border shadow-sm" style={{borderColor: '#ebc2b5'}}>
                                <div className="flex items-center gap-1 p-1.5">
                                  <Database className="w-3 h-3 shrink-0" style={{color: '#D95C3F'}} />
                                  <span className="text-[11px] font-mono font-semibold text-stone-800 truncate flex-1">{mk}</span>
                                  <button onClick={() => removeMart(mk)} className="p-0.5 text-stone-400 hover:text-red-500 hover:bg-red-50 rounded shrink-0" title="제거">
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                                <div className="px-2 pb-1 text-[10px] text-stone-500 truncate">{meta.description}</div>
                              </div>
                            );
                          })
                        )}
                      </div>
                      {selectedMarts.length >= 2 && (
                        <div className="px-2.5 py-1.5 border-t text-[10px] font-mono" style={{backgroundColor: '#f8e5dd', borderColor: '#ebc2b5', color: '#8f3a22'}}>
                          {selectedMarts.join(' ⋈ ')}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 하단: 중앙 노트북 + 우측 네비 */}
        <div className="flex-1 flex overflow-hidden">
          <main className="flex-1 flex flex-col overflow-hidden relative">
            <div className="flex-1 overflow-auto hide-scrollbar">
              <div style={{paddingLeft: '16px', paddingRight: '16px', paddingTop: '8px', paddingBottom: '8px'}}>
                {cells.map((cell, idx) => (
                  <div key={cell.id} ref={el => cellRefs.current[cell.id] = el}
                    className="group relative py-5 border-b transition-colors"
                    style={{ borderColor: '#ede9dd', backgroundColor: activeCellId === cell.id ? 'rgba(253, 237, 232, 0.25)' : 'transparent' }}
                    onClick={() => setActiveCellId(cell.id)}>

                    <div className="flex items-center justify-between mb-2 px-4">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono text-stone-400">[{idx + 1}]</span>
                        <button onClick={(e) => { e.stopPropagation(); cycleCellType(cell.id); }}
                          className="text-[10px] font-bold px-1.5 py-0.5 rounded transition-all hover:opacity-80 hover:scale-105 cursor-pointer"
                          style={typeColors(cell.type)}
                          title="클릭하여 셀 타입 변경 (SQL → Python → MD)">
                          {typeLabel(cell.type)}
                        </button>
                        <input type="text" value={cell.name} onChange={e => updateCell(cell.id, { name: e.target.value })}
                          className="text-sm font-mono font-semibold text-stone-800 bg-transparent border-none focus:outline-none focus:bg-white px-1 rounded" />
                        {cell.agentGenerated && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1" style={{backgroundColor: '#fdede8', color: '#8f3a22'}}>
                            <Bot className="w-2.5 h-2.5" /> 에이전트
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {cell.type !== 'markdown' && (
                          <button onClick={() => runCell(cell.id)} className="p-1.5 rounded text-stone-600" title="실행"
                            onMouseEnter={e => { e.currentTarget.style.color = '#D95C3F'; e.currentTarget.style.backgroundColor = '#fdede8'; }}
                            onMouseLeave={e => { e.currentTarget.style.color = ''; e.currentTarget.style.backgroundColor = 'transparent'; }}>
                            <Play className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button onClick={() => deleteCell(cell.id)} className="p-1.5 rounded text-stone-600 hover:text-red-600 hover:bg-red-50" title="삭제">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 mb-2 px-4">
                      <button onClick={() => updateCell(cell.id, { activeTab: 'code' })}
                        className="text-xs font-semibold flex items-center gap-1.5 pb-1 border-b-2 transition-colors"
                        style={{ borderColor: cell.activeTab === 'code' ? '#D95C3F' : 'transparent', color: cell.activeTab === 'code' ? '#D95C3F' : '#a8a29e' }}>
                        <Code className="w-3.5 h-3.5" /> 입력
                      </button>
                      <button onClick={() => updateCell(cell.id, { activeTab: 'output' })}
                        className="text-xs font-semibold flex items-center gap-1.5 pb-1 border-b-2 transition-colors"
                        style={{ borderColor: cell.activeTab === 'output' ? '#D95C3F' : 'transparent', color: cell.activeTab === 'output' ? '#D95C3F' : '#a8a29e' }}>
                        <BarChart3 className="w-3.5 h-3.5" /> 출력
                        {cell.executed && cell.type !== 'markdown' && <span className="w-1.5 h-1.5 rounded-full" style={{backgroundColor: '#65a30d'}}></span>}
                      </button>
                    </div>

                    <div className="px-4">
                      {cell.activeTab === 'code' ? (
                        <textarea value={cell.code} onChange={e => updateCell(cell.id, { code: e.target.value })}
                          className="w-full px-4 py-3 font-mono text-xs focus:outline-none resize-y rounded-md leading-relaxed"
                          style={{ minHeight: '240px',
                            backgroundColor: cell.type === 'markdown' ? '#ffffff' : '#2d2a26',
                            color: cell.type === 'markdown' ? '#2d2a26' : '#f5f4ed',
                            border: cell.type === 'markdown' ? '1px solid #ede9dd' : 'none' }}
                          spellCheck={false} />
                      ) : (
                        <div className="rounded-md overflow-hidden" style={{backgroundColor: '#faf8f2', border: '1px solid #ede9dd'}}>
                          {cell.type === 'markdown' ? renderMarkdown(cell.code)
                            : !cell.executed ? <div className="text-stone-400 text-xs p-6 text-center">실행 전 — 버튼을 누르거나 채팅으로 요청하세요</div>
                            : cell.type === 'sql' ? renderTable(cell.output)
                            : renderChart()}
                        </div>
                      )}
                    </div>

                    {cell.insight && (
                      <div className="mt-2 mx-4 px-3 py-2 rounded-md text-xs flex items-start gap-2" style={{backgroundColor: '#fdede8', color: '#8f3a22'}}>
                        <Bot className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>{cell.insight}</span>
                      </div>
                    )}

                    {activeCellId === cell.id && (
                      <div className="mt-3 mx-4 rounded-2xl transition-all" style={{backgroundColor: '#ffffff', border: '1px solid #ede9dd', boxShadow: '0 1px 2px rgba(45, 42, 38, 0.03)'}}>
                        <div className="px-4 pt-3 pb-2">
                          <textarea value={cell.chatInput} onChange={e => updateCell(cell.id, { chatInput: e.target.value })}
                            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleChatSubmit(cell.id); } }}
                            placeholder={cell.type === 'sql' ? '바이브로 쿼리를 수정해보세요 — 예: 시도별로 group by 해줘' : cell.type === 'python' ? '바이브로 차트를 수정해보세요 — 예: pie 차트로 바꿔줘' : '바이브로 문서를 수정해보세요'}
                            rows={1}
                            className="w-full bg-transparent text-sm text-stone-800 placeholder-stone-400 focus:outline-none resize-none leading-relaxed"
                            style={{minHeight: '24px', maxHeight: '120px'}} />
                        </div>
                        <div className="flex items-center justify-between px-3 pb-2 pt-0.5">
                          <div className="flex items-center gap-2 pl-1">
                            {cell.chatHistory && cell.chatHistory.length > 0 && (
                              <button onClick={() => updateCell(cell.id, { historyOpen: !cell.historyOpen })}
                                className="text-[11px] text-stone-500 hover:text-stone-700 flex items-center gap-1 transition-colors">
                                <MessageSquare className="w-3 h-3" /> <span>대화 {cell.chatHistory.length}</span>
                              </button>
                            )}
                          </div>
                          <button onClick={() => handleChatSubmit(cell.id)} disabled={!cell.chatInput.trim()}
                            className="w-8 h-8 rounded-full flex items-center justify-center transition-all disabled:cursor-not-allowed"
                            style={{ backgroundColor: cell.chatInput.trim() ? '#D95C3F' : '#ede9dd', color: '#ffffff' }}>
                            <ArrowUp className="w-4 h-4" strokeWidth={2.5} />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                <div className="py-6"></div>
              </div>
            </div>

            {/* 하단 고정 셀 추가 바 */}
            <div className="h-14 border-t flex items-center justify-center gap-1 shrink-0" style={{borderColor: '#ede9dd', backgroundColor: '#fdfcf8'}}>
              <span className="text-[10px] font-semibold text-stone-400 uppercase tracking-wide mr-2 flex items-center gap-1">
                <Plus className="w-3 h-3" strokeWidth={2.5} /> 셀 추가
              </span>
              <button onClick={() => addCell('sql')} className="px-3 py-1.5 rounded-md text-xs font-semibold transition-colors"
                style={{color: '#78716c'}}
                onMouseEnter={e => { e.currentTarget.style.color = '#D95C3F'; e.currentTarget.style.backgroundColor = '#fdede8'; }}
                onMouseLeave={e => { e.currentTarget.style.color = '#78716c'; e.currentTarget.style.backgroundColor = 'transparent'; }}>SQL</button>
              <button onClick={() => addCell('python')} className="px-3 py-1.5 rounded-md text-xs font-semibold transition-colors"
                style={{color: '#78716c'}}
                onMouseEnter={e => { e.currentTarget.style.color = '#D95C3F'; e.currentTarget.style.backgroundColor = '#fdede8'; }}
                onMouseLeave={e => { e.currentTarget.style.color = '#78716c'; e.currentTarget.style.backgroundColor = 'transparent'; }}>Python</button>
              <button onClick={() => addCell('markdown')} className="px-3 py-1.5 rounded-md text-xs font-semibold transition-colors"
                style={{color: '#78716c'}}
                onMouseEnter={e => { e.currentTarget.style.color = '#D95C3F'; e.currentTarget.style.backgroundColor = '#fdede8'; }}
                onMouseLeave={e => { e.currentTarget.style.color = '#78716c'; e.currentTarget.style.backgroundColor = 'transparent'; }}>Markdown</button>
            </div>

            <button onClick={() => setAgentMode(!agentMode)}
              className="fixed bottom-6 right-6 w-14 h-14 rounded-full shadow-xl flex items-center justify-center transition-all hover:scale-110 z-40"
              style={{ backgroundColor: agentMode ? '#D95C3F' : '#ffffff', border: agentMode ? 'none' : '1px solid #e7e5e0', color: agentMode ? '#ffffff' : '#57534e' }}
              title={agentMode ? '에이전트 모드 끄기' : '에이전트 모드 켜기'}>
              {agentMode ? <Zap className="w-5 h-5" strokeWidth={2.25} /> : <Wand2 className="w-5 h-5" strokeWidth={1.75} />}
              {agentMode && <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full border-2 border-white" style={{backgroundColor: '#84cc16'}}></span>}
            </button>

            {agentMode && (
              <div className="fixed bottom-6 z-30 flex flex-col overflow-hidden rounded-2xl shadow-2xl"
                style={{ left: '240px', right: '268px', maxHeight: 'calc(100vh - 180px)', backgroundColor: '#ffffff', border: '1px solid #ede9dd' }}>
                <div className="flex items-center justify-between px-4 py-2.5 border-b" style={{borderColor: '#ede9dd', backgroundColor: '#faf8f2'}}>
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full flex items-center justify-center" style={{backgroundColor: '#D95C3F'}}>
                      <Zap className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-stone-800">에이전트 모드</div>
                      <div className="text-[10px] text-stone-500">노트북 전체와 대화하며 분석을 이어가세요</div>
                    </div>
                  </div>
                  <button onClick={() => setAgentMode(false)} className="p-1 rounded hover:bg-stone-100 text-stone-400 hover:text-stone-700 transition-colors">
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {agentChatHistory.length > 0 && (
                  <div className="flex-1 overflow-auto hide-scrollbar px-4 py-3 space-y-3" style={{maxHeight: '320px'}}>
                    {agentChatHistory.map(msg => (
                      <div key={msg.id} className={`flex gap-2.5 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                        <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
                          style={{ background: msg.role === 'user' ? 'linear-gradient(135deg, #ebc2b5, #D95C3F)' : '#D95C3F' }}>
                          {msg.role === 'user' ? <User className="w-3.5 h-3.5 text-white" strokeWidth={2} /> : <Sparkles className="w-3.5 h-3.5 text-white" strokeWidth={2} />}
                        </div>
                        <div className={`flex-1 max-w-[80%] ${msg.role === 'user' ? 'text-right' : ''}`}>
                          <div className="flex items-center gap-1.5 mb-0.5" style={{justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start'}}>
                            <span className="text-[10px] font-semibold text-stone-700">{msg.role === 'user' ? '하우' : '에이전트'}</span>
                            <span className="text-[9px] text-stone-400">{msg.timestamp}</span>
                          </div>
                          <div className="inline-block px-3 py-2 rounded-xl text-sm text-stone-800 whitespace-pre-wrap text-left leading-relaxed"
                            style={{ backgroundColor: msg.role === 'user' ? '#fdede8' : '#faf8f2', border: '1px solid', borderColor: msg.role === 'user' ? '#f5d5c8' : '#ede9dd' }}>
                            {msg.content}
                          </div>
                          {msg.createdCellIds && msg.createdCellIds.length > 0 && (
                            <button onClick={() => scrollToCell(msg.createdCellIds[0])}
                              className="mt-1.5 text-[10px] font-semibold flex items-center gap-1 transition-colors"
                              style={{color: '#D95C3F'}}>
                              <Plus className="w-2.5 h-2.5" strokeWidth={2.5} /> 셀 {msg.createdCellIds.length}개 생성됨 · 보러가기
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="px-4 py-3" style={{borderTop: agentChatHistory.length > 0 ? '1px solid #ede9dd' : 'none'}}>
                  {agentChatHistory.length === 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {['강남구 세부 분석해줘', '전체 인사이트 요약', '상품별 효율 비교'].map(s => (
                        <button key={s} onClick={() => setAgentChatInput(s)}
                          className="text-[11px] px-2.5 py-1 rounded-full border transition-all"
                          style={{borderColor: '#ede9dd', color: '#78716c', backgroundColor: '#faf8f2'}}
                          onMouseEnter={e => { e.currentTarget.style.borderColor = '#D95C3F'; e.currentTarget.style.color = '#D95C3F'; }}
                          onMouseLeave={e => { e.currentTarget.style.borderColor = '#ede9dd'; e.currentTarget.style.color = '#78716c'; }}>
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex items-end gap-2">
                    <textarea value={agentChatInput} onChange={e => setAgentChatInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAgentChatSubmit(); } }}
                      placeholder="에이전트에게 노트북 전체에 대해 질문하거나 분석을 요청하세요..."
                      rows={1}
                      className="flex-1 text-sm text-stone-800 placeholder-stone-400 focus:outline-none resize-none leading-relaxed px-3 py-2 rounded-xl"
                      style={{ minHeight: '36px', maxHeight: '120px', backgroundColor: '#faf8f2', border: '1px solid #ede9dd' }}
                      onFocus={e => e.target.style.borderColor = '#D95C3F'}
                      onBlur={e => e.target.style.borderColor = '#ede9dd'} />
                    <button onClick={handleAgentChatSubmit} disabled={!agentChatInput.trim()}
                      className="w-9 h-9 rounded-full flex items-center justify-center transition-all disabled:cursor-not-allowed shrink-0"
                      style={{ backgroundColor: agentChatInput.trim() ? '#D95C3F' : '#ede9dd', color: '#ffffff' }}>
                      <ArrowUp className="w-4 h-4" strokeWidth={2.5} />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </main>

          <aside className="w-64 flex flex-col shrink-0" style={{backgroundColor: '#fdfcf8', paddingLeft: '16px'}}>
            {selectedMarts.length > 0 && (
              <div className="px-2 pt-6 pb-3 shrink-0">
                <div className="text-[10px] font-semibold text-stone-500 uppercase tracking-wide flex items-center gap-1.5 leading-tight mb-2">
                  <Layers className="w-3 h-3" strokeWidth={2} />
                  <span>사용 중인 마트</span>
                  <span className="text-stone-400 font-normal normal-case">({selectedMarts.length})</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {selectedMarts.map(m => (
                    <span key={m} className="text-[10px] font-mono px-1.5 py-0.5 rounded border flex items-center gap-1"
                      style={{backgroundColor: '#fff', borderColor: '#ebc2b5', color: '#8f3a22'}}
                      title={martMetadata[m]?.description || m}>
                      <Database className="w-2.5 h-2.5" style={{color: '#D95C3F'}} />
                      {m}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {selectedMarts.length > 0 && <div className="mx-2 border-t border-stone-200"></div>}

            <div className="px-2 pt-4 pb-3 flex flex-col justify-center shrink-0">
              <div className="text-[10px] font-semibold text-stone-500 uppercase tracking-wide flex items-center gap-1.5 leading-tight">
                <Compass className="w-3 h-3" strokeWidth={2} /> 셀 네비게이션
              </div>
              <div className="text-[10px] text-stone-400 mt-0.5 leading-tight">{cells.length}개 셀 / {cells.filter(c => c.executed).length}개 실행됨</div>
            </div>

            {/* 상단 절반: 셀 네비게이션 */}
            <div className="overflow-auto hide-scrollbar p-2" style={{flex: '1 1 50%', minHeight: 0}}>
              {cells.map((cell, idx) => (
                <div key={cell.id} className="mb-0.5">
                  <button onClick={() => scrollToCell(cell.id)}
                    className="w-full text-left px-2 py-1.5 rounded transition-colors border"
                    style={{
                      backgroundColor: activeCellId === cell.id ? '#fdede8' : 'transparent',
                      borderColor: activeCellId === cell.id ? '#ebc2b5' : 'transparent'
                    }}>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-stone-400 font-mono shrink-0">[{idx + 1}]</span>
                      <span className="text-[9px] font-bold px-1 py-0.5 rounded shrink-0" style={typeColors(cell.type)}>
                        {typeLabel(cell.type)}
                      </span>
                      <span className="text-xs font-mono font-semibold text-stone-800 truncate flex-1" title={cell.name}>{cell.name}</span>
                      {cell.agentGenerated && <Bot className="w-3 h-3 shrink-0" style={{color: '#D95C3F'}} />}
                      {cell.executed && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{backgroundColor: '#65a30d'}}></span>}
                    </div>
                  </button>

                  {cell.chatHistory && cell.chatHistory.length > 0 && (
                    <div className="ml-2 mt-0.5">
                      <button onClick={(e) => { e.stopPropagation(); updateCell(cell.id, { historyOpen: !cell.historyOpen }); }}
                        className="w-full flex items-center gap-1 px-2 py-1 text-[10px] text-stone-500 hover:text-stone-700 rounded transition-colors">
                        {cell.historyOpen ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
                        <MessageSquare className="w-2.5 h-2.5" />
                        <span>대화 이력</span>
                        <span className="text-stone-400">({cell.chatHistory.length})</span>
                      </button>

                      {cell.historyOpen && (
                        <div className="ml-3 mt-1 pl-2 border-l-2 border-stone-200 space-y-1.5 pb-2">
                          {cell.chatHistory.map((entry, hIdx) => {
                            const isCurrent = entry.codeSnapshot === cell.code;
                            return (
                              <div key={entry.id} onClick={() => rollbackToHistory(cell.id, entry.id)}
                                className="group relative rounded-lg border p-2 cursor-pointer transition-all"
                                style={{ backgroundColor: isCurrent ? '#fdede8' : '#ffffff', borderColor: isCurrent ? '#ebc2b5' : '#e7e5e0' }}
                                title="이 시점의 코드로 되돌리기">
                                <div className="flex items-center justify-between mb-1">
                                  <div className="flex items-center gap-1">
                                    <span className="text-[9px] font-mono text-stone-400">#{hIdx + 1}</span>
                                    <span className="text-[9px] text-stone-400">{entry.timestamp}</span>
                                  </div>
                                  {isCurrent ? (
                                    <span className="text-[8px] font-semibold bg-white px-1 py-0.5 rounded border" style={{color: '#D95C3F', borderColor: '#ebc2b5'}}>현재</span>
                                  ) : (
                                    <span className="text-[8px] font-semibold text-stone-400 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5">
                                      <RotateCcw className="w-2.5 h-2.5" /> 되돌리기
                                    </span>
                                  )}
                                </div>
                                <div className="flex gap-1.5 items-start">
                                  <div className="w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0 mt-0.5" style={{background: 'linear-gradient(135deg, #ebc2b5, #D95C3F)'}}>
                                    <User className="w-2 h-2 text-white" />
                                  </div>
                                  <div className="text-[10px] text-stone-800 font-medium leading-snug flex-1">{entry.user}</div>
                                </div>
                                <div className="flex gap-1.5 items-start mt-1 pt-1 border-t border-stone-100">
                                  <div className="w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0 mt-0.5" style={{backgroundColor: '#D95C3F'}}>
                                    <Sparkles className="w-2 h-2 text-white" />
                                  </div>
                                  <div className="text-[10px] text-stone-600 leading-snug flex-1">{entry.assistant}</div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* 하단 절반: 에이전트 대화 이력 */}
            <div className="border-t border-stone-200 flex flex-col" style={{flex: '1 1 50%', minHeight: 0}}>
              <div className="px-2 pt-3 pb-2 shrink-0 flex items-center gap-1.5">
                <div className="w-4 h-4 rounded-full flex items-center justify-center" style={{backgroundColor: agentMode ? '#D95C3F' : '#e7e5e0'}}>
                  <Zap className="w-2.5 h-2.5 text-white" strokeWidth={2.5} />
                </div>
                <span className="text-[10px] font-semibold text-stone-500 uppercase tracking-wide leading-tight">에이전트 이력</span>
                {agentChatHistory.length > 0 && (
                  <span className="text-[9px] text-stone-400">({Math.floor(agentChatHistory.length / 2)})</span>
                )}
              </div>

              <div className="flex-1 overflow-auto hide-scrollbar px-2 pb-2">
                {agentChatHistory.length === 0 ? (
                  <div className="text-[10px] text-stone-400 text-center px-3 py-6 leading-relaxed">
                    에이전트 모드를 켜고<br />
                    대화를 시작해보세요
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {agentChatHistory.map(msg => (
                      <div
                        key={msg.id}
                        className="rounded-md p-1.5 border"
                        style={{
                          backgroundColor: msg.role === 'user' ? '#ffffff' : '#faf8f2',
                          borderColor: msg.role === 'user' ? '#e7e5e0' : '#ede9dd'
                        }}
                      >
                        <div className="flex items-center gap-1 mb-0.5">
                          <div
                            className="w-3 h-3 rounded-full flex items-center justify-center shrink-0"
                            style={{
                              background: msg.role === 'user' ? 'linear-gradient(135deg, #ebc2b5, #D95C3F)' : '#D95C3F'
                            }}
                          >
                            {msg.role === 'user'
                              ? <User className="w-1.5 h-1.5 text-white" strokeWidth={2.5} />
                              : <Sparkles className="w-1.5 h-1.5 text-white" strokeWidth={2.5} />}
                          </div>
                          <span className="text-[9px] font-semibold text-stone-600">
                            {msg.role === 'user' ? '하우' : '에이전트'}
                          </span>
                          <span className="text-[8px] text-stone-400 ml-auto">{msg.timestamp}</span>
                        </div>
                        <div className="text-[10px] text-stone-700 leading-snug line-clamp-3">
                          {msg.content}
                        </div>
                        {msg.createdCellIds && msg.createdCellIds.length > 0 && (
                          <button
                            onClick={() => scrollToCell(msg.createdCellIds[0])}
                            className="mt-1 text-[9px] font-semibold flex items-center gap-0.5 transition-colors"
                            style={{color: '#D95C3F'}}
                          >
                            <Plus className="w-2 h-2" strokeWidth={2.5} />
                            셀 {msg.createdCellIds.length}개 생성 · 보기
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>
      </div>

      {/* 리포팅 모달 */}
      {showReportModal && (
        <div className="fixed inset-0 flex items-center justify-center z-50" style={{backgroundColor: 'rgba(87, 83, 78, 0.4)'}}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
            <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between">
              <div>
                <div className="font-semibold text-stone-900 flex items-center gap-1.5"><FileText className="w-4 h-4" strokeWidth={2} /> 리포팅 초안 생성</div>
                <div className="text-xs text-stone-500 mt-0.5">포함할 셀을 선택하세요</div>
              </div>
              <button onClick={() => setShowReportModal(false)} className="p-1 hover:bg-stone-100 rounded"><X className="w-4 h-4 text-stone-500" /></button>
            </div>
            <div className="flex-1 overflow-auto p-4 space-y-2">
              {cells.map(cell => (
                <label key={cell.id} className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors"
                  style={{ borderColor: selectedCells[cell.id] ? '#ebc2b5' : '#e7e5e0', backgroundColor: selectedCells[cell.id] ? '#fdede8' : '#ffffff' }}>
                  <input type="checkbox" checked={!!selectedCells[cell.id]}
                    onChange={e => setSelectedCells({...selectedCells, [cell.id]: e.target.checked})}
                    disabled={!cell.executed}
                    className="w-4 h-4" style={{accentColor: '#D95C3F'}} />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] font-bold px-1 py-0.5 rounded" style={typeColors(cell.type)}>{typeLabel(cell.type)}</span>
                      <span className="text-sm font-mono font-semibold text-stone-800">{cell.name}</span>
                    </div>
                    {!cell.executed && <div className="text-[10px] mt-0.5 flex items-center gap-0.5" style={{color: '#D95C3F'}}><Info className="w-2.5 h-2.5" strokeWidth={2} /> 실행되지 않음</div>}
                  </div>
                </label>
              ))}
            </div>
            <div className="px-5 py-3 border-t border-stone-200 flex gap-2">
              <button onClick={() => setShowReportModal(false)} className="flex-1 px-3 py-2 text-xs font-semibold text-stone-600 hover:bg-stone-100 rounded">취소</button>
              <button onClick={generateReport} disabled={Object.values(selectedCells).filter(Boolean).length === 0}
                className="flex-1 px-3 py-2 text-xs font-semibold text-white rounded disabled:opacity-40 hover:shadow-md"
                style={{backgroundColor: '#D95C3F'}}>
                {Object.values(selectedCells).filter(Boolean).length}개 셀로 생성
              </button>
            </div>
          </div>
        </div>
      )}

      {generatingReport && (
        <div className="fixed inset-0 flex items-center justify-center z-50" style={{backgroundColor: 'rgba(87, 83, 78, 0.3)'}}>
          <div className="bg-white rounded-xl px-8 py-6 shadow-2xl flex flex-col items-center gap-3">
            <div className="w-12 h-12 rounded-full flex items-center justify-center animate-pulse" style={{backgroundColor: '#D95C3F'}}>
              <Sparkles className="w-6 h-6 text-white" />
            </div>
            <div className="text-sm font-semibold text-stone-800">리포팅 작성 중...</div>
          </div>
        </div>
      )}

      {showReport && (
        <div className="fixed inset-0 flex items-center justify-center z-50 p-6" style={{backgroundColor: 'rgba(87, 83, 78, 0.4)'}}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl h-full flex flex-col">
            <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between">
              <div className="font-semibold text-stone-900 flex items-center gap-2">
                <FileText className="w-4 h-4" /> 리포팅 초안 (Markdown)
              </div>
              <div className="flex gap-2">
                <button onClick={() => navigator.clipboard?.writeText(reportContent)} className="px-3 py-1.5 text-xs font-semibold text-stone-600 hover:bg-stone-100 rounded flex items-center gap-1">
                  <Copy className="w-3.5 h-3.5" /> 복사
                </button>
                <button onClick={() => setShowReport(false)} className="p-1.5 hover:bg-stone-100 rounded"><X className="w-4 h-4 text-stone-500" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-6" style={{backgroundColor: '#faf9f5'}}>
              <pre className="text-xs font-mono text-stone-800 whitespace-pre-wrap bg-white p-5 rounded-lg border border-stone-200">{reportContent}</pre>
            </div>
          </div>
        </div>
      )}

      {rollbackToast && (
        <div className="fixed top-24 right-72 text-white px-4 py-2.5 rounded-lg shadow-xl z-50 flex items-center gap-2" style={{backgroundColor: '#D95C3F'}}>
          <RotateCcw className="w-4 h-4" />
          <div className="text-xs">
            <div className="font-semibold"><span className="font-mono">{rollbackToast.cellName}</span> 롤백 완료</div>
            <div className="text-[10px]" style={{color: '#fdede8'}}>{rollbackToast.timestamp} 시점의 코드로 복원했어요</div>
          </div>
        </div>
      )}
    </div>
  );
}

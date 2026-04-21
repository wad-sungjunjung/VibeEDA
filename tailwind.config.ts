import type { Config } from 'tailwindcss'

// 색 토큰을 CSS 변수(rgb triplet) 기반으로 정의해 light/dark 테마를 런타임에 전환한다.
// 실제 팔레트 값은 src/styles/globals.css 의 :root / .dark 선택자에 정의돼 있다.
const c = (name: string) => `rgb(var(--color-${name}) / <alpha-value>)`

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Backgrounds
        'bg-page': c('bg-page'),
        'bg-sidebar': c('bg-sidebar'),
        'bg-pane': c('bg-pane'),
        'bg-output': c('bg-output'),
        'bg-code': c('bg-code'),
        // 카드/모달/인풋 등 elevated surface
        surface: {
          DEFAULT: c('surface'),
          hover: c('surface-hover'),
        },
        // 중립 chip/hover (stone-100 대체)
        chip: {
          DEFAULT: c('chip'),
          hover: c('chip-hover'),
        },

        // Primary (Coral)
        primary: {
          DEFAULT: c('primary'),
          hover: c('primary-hover'),
          light: c('primary-light'),
          pale: c('primary-pale'),
          border: c('primary-border'),
          text: c('primary-text'),
        },

        // Text
        text: {
          primary: c('text-primary'),
          secondary: c('text-secondary'),
          tertiary: c('text-tertiary'),
          disabled: c('text-disabled'),
        },

        // Borders
        border: {
          DEFAULT: c('border'),
          subtle: c('border-subtle'),
          hover: c('border-hover'),
        },

        // Cell types
        sql: { bg: c('sql-bg'), text: c('sql-text') },
        python: { bg: c('python-bg'), text: c('python-text') },
        markdown: { bg: c('markdown-bg'), text: c('markdown-text') },

        // Status
        success: c('success'),
        'success-indicator': c('success-indicator'),
        danger: c('danger'),
        'danger-bg': c('danger-bg'),
        warning: c('warning'),
        'warning-bg': c('warning-bg'),
        'warning-text': c('warning-text'),
      },
      fontFamily: {
        sans: ['Pretendard', '-apple-system', 'Malgun Gothic', 'sans-serif'],
        mono: ["'SF Mono'", 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: {
        sm: '4px',
        DEFAULT: '4px',
        md: '6px',
        lg: '8px',
        xl: '12px',
        '2xl': '16px',
      },
      width: {
        'sidebar-left': '224px',
        'sidebar-right': '256px',
      },
      height: {
        header: '56px',
        'cell-bar': '56px',
      },
      minWidth: {
        screen: '1280px',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
      },
    },
  },
  plugins: [],
} satisfies Config

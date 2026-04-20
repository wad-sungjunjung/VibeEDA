import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Backgrounds
        'bg-page': '#faf9f5',
        'bg-sidebar': '#f5f4ed',
        'bg-pane': '#fdfcf8',
        'bg-output': '#faf8f2',
        'bg-code': '#2d2a26',

        // Primary (Coral)
        primary: {
          DEFAULT: '#D95C3F',
          hover: '#C24E34',
          light: '#fdede8',
          pale: '#f8e5dd',
          border: '#ebc2b5',
          text: '#8f3a22',
        },

        // Text
        text: {
          primary: '#2d2a26',
          secondary: '#57534e',
          tertiary: '#78716c',
          disabled: '#a8a29e',
        },

        // Borders
        border: {
          DEFAULT: '#e7e5e0',
          subtle: '#ede9dd',
          hover: '#d6d3c7',
        },

        // Cell types
        sql: { bg: '#e8e4d8', text: '#5c4a1e' },
        python: { bg: '#e6ede0', text: '#3d5226' },
        markdown: { bg: '#eae4df', text: '#4a3c2e' },

        // Status
        success: '#65a30d',
        'success-indicator': '#84cc16',
        danger: '#dc2626',
        'danger-bg': '#fef2f2',
        warning: '#d97706',
        'warning-bg': '#fef3c7',
        'warning-text': '#92400e',
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

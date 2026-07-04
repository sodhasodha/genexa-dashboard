/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'los-bg': '#0a0a0f',
        'los-surface': '#13131a',
        'los-surface-2': '#1a1a24',
        'los-surface-3': '#0f0f16',
        'los-border': 'rgba(255,255,255,0.07)',
        'los-border-hover': 'rgba(255,255,255,0.14)',
        'los-text': '#e8e8ec',
        'los-text-secondary': '#a0a0ab',
        'los-text-muted': '#6b6b78',
        'los-accent': '#3b82f6',
        'los-accent-soft': 'rgba(59,130,246,0.14)',
        'los-green': '#22c55e',
        'los-red': '#ef4444',
        'los-amber': '#f59e0b',
      },
      fontFamily: {
        inter: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        los: '12px',
      },
    },
  },
  plugins: [],
}

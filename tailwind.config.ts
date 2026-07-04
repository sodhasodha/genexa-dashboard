/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'los-bg': '#F3F2EE',
        'los-surface': '#FFFFFF',
        'los-surface-2': '#F8F7F4',
        'los-border': 'rgba(0,0,0,0.07)',
        'los-border-hover': 'rgba(0,0,0,0.15)',
        'los-text': '#0F0F0F',
        'los-text-secondary': '#52524E',
        'los-text-muted': '#9B9B95',
        'los-accent': '#1D4ED8',
        'los-green': '#16A34A',
        'los-red': '#DC2626',
        'los-amber': '#D97706',
      },
      fontFamily: {
        'inter': ['Inter', 'sans-serif'],
        'mono': ['JetBrains Mono', 'monospace'],
      },
      boxShadow: {
        'los-card': '0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.06)',
        'los-card-hover': '0 2px 4px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.10)',
      },
      borderRadius: {
        'los': '16px',
      },
    },
  },
  plugins: [],
}

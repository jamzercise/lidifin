/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        "./pages/**/*.{js,ts,jsx,tsx,mdx}",
        "./components/**/*.{js,ts,jsx,tsx,mdx}",
        "./app/**/*.{js,ts,jsx,tsx,mdx}",
    ],
    theme: {
        extend: {
            colors: {
                brand: {
                    DEFAULT: '#fca200',
                    hover: '#e69200',
                    light: '#fcb84d',
                    dark: '#d48c00'
                },
                /* Theme-aware colors (use CSS variables) */
                theme: {
                    primary: 'var(--bg-primary)',
                    secondary: 'var(--bg-secondary)',
                    tertiary: 'var(--bg-tertiary)',
                    hover: 'var(--bg-hover)',
                    active: 'var(--bg-active)',
                    'text-primary': 'var(--text-primary)',
                    'text-body': 'var(--text-body)',
                    'text-secondary': 'var(--text-secondary)',
                    'text-muted': 'var(--text-muted)',
                    'border-subtle': 'var(--border-subtle)',
                    'border-interactive': 'var(--border-interactive)',
                    'border-focus': 'var(--border-focus)',
                }
            },
            screens: {
                '3xl': '1920px',  // TV/Large Desktop
                '4xl': '2560px',  // 4K TV/Large TV
            },
        },
    },
    plugins: [],
}
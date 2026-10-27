/** @type {import('tailwindcss').Config} */

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    container: {
      center: true,
    },
    extend: {
      fontFamily: {
        serif: ["'KaiTi'", "'楷体'", "'STKaiti'", "'华文楷体'", "serif"],
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
};

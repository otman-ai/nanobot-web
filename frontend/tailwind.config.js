/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"] ,
  theme: {
    extend: {
      colors: {
        fog: "#ebedf1",
        blunt: "#d4d8df",
        timber: "#acadb1",
        smoked: "#706f70",
        jet: "#353536",
        ink: "#080808"
      },
      fontFamily: {
        sans: ["IBM Plex Sans", "system-ui", "sans-serif"],
        display: ["Space Grotesk", "system-ui", "sans-serif"]
      },
      boxShadow: {
        soft: "0 20px 60px rgba(8, 8, 8, 0.15)",
        card: "0 12px 30px rgba(8, 8, 8, 0.12)"
      }
    }
  },
  plugins: []
};

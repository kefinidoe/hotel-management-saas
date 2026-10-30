import type { Config } from "tailwindcss";
import { BRAND_COLORS } from "./lib/brand";

// HotelFlow design tokens: clean neutrals with a deep teal primary and fresh
// aqua accent. Keep components on shared tokens for a consistent SaaS identity.

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Neutral base
        bg: "#F6F9FA",
        surface: "#FFFFFF",
        border: "#DCE6E9",
        text: {
          primary: "#1D3036",
          secondary: "#61747A",
          muted: "#94A4A8",
        },
        primary: {
          50: "#EAF3F5",
          100: "#D2E5E8",
          300: "#79AEB7",
          400: "#388B98",
          500: BRAND_COLORS.primary,
          600: "#0B4B58",
          700: "#083B45",
        },
        accent: {
          50: "#E8F7F5",
          100: "#D4F0EC",
          200: "#B8E8E2",
          400: "#55C8BC",
          500: BRAND_COLORS.accent,
          600: "#16877C",
        },
        sidebar: {
          bg: "#16323A",
          hover: "#224650",
          active: "#35B9AC",
          text: "#F2F8F9",
          textMuted: "rgba(242, 248, 249, 0.68)",
          border: "rgba(242, 248, 249, 0.09)",
        },
        success: "#2E7D46",
        warning: "#B8860B",
        danger: "#B3261E",
        info: "#2563A8",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      borderRadius: {
        card: "12px",
        control: "8px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(31, 36, 33, 0.04), 0 2px 8px rgba(31, 36, 33, 0.06)",
        popover: "0 4px 16px rgba(31, 36, 33, 0.12)",
      },
      spacing: {
        4.5: "1.125rem",
      },
    },
  },
  plugins: [],
};

export default config;
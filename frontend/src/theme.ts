import { Platform } from "react-native";

export const colors = {
  bg: "#FFFFFF",
  surface: "#F9FAFB",
  surfaceAlt: "#F3F4F6",
  primary: "#0044FF",
  primaryHover: "#0033CC",
  text: "#111827",
  textMuted: "#4B5563",
  textSubtle: "#6B7280",
  border: "#E5E7EB",
  borderStrong: "#D1D5DB",
  success: "#057A55",
  warning: "#F59E0B",
  error: "#E02424",
  black: "#0B0B0F",
};

export const radii = { sm: 4, md: 8, lg: 12, xl: 16 };
export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };

// Use platform-default sharp sans-serif. Avoids extra font loading and keeps
// the Swiss/high-contrast feel via weight + tracking + scale.
export const fonts = {
  heading: Platform.select({ ios: "Avenir Next", android: "sans-serif", default: "system-ui" }),
  body: Platform.select({ ios: "Avenir Next", android: "sans-serif", default: "system-ui" }),
};

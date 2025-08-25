import { createContext, useContext } from "react";
import {
  OnboardingTheme,
  ThemeName,
  getTheme,
  getThemeClasses,
  defaultTheme,
} from "./themes";

// Theme context
export const ThemeContext = createContext<{
  theme: OnboardingTheme;
  themeName: ThemeName | undefined;
  setTheme: (themeName: ThemeName) => void;
}>({
  theme: defaultTheme,
  themeName: undefined,
  setTheme: () => {},
});

// Hook to use theme in components
export const useOnboardingTheme = () => {
  const { theme, themeName, setTheme } = useContext(ThemeContext);

  return {
    theme,
    themeName,
    setTheme,
    classes: getThemeClasses(theme),
    colors: theme.colors,
  };
};

// Helper hook for getting theme without context (for standalone usage)
export const useThemeClasses = (themeName?: ThemeName) => {
  const theme = getTheme(themeName);
  return {
    theme,
    classes: getThemeClasses(theme),
    colors: theme.colors,
  };
};

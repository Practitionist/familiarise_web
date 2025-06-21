// Onboarding Form Themes Configuration
// Each theme provides consistent colors for glassmorphism effects, gradients, and UI elements

export interface OnboardingTheme {
  name: string;
  description: string;
  colors: {
    // Background gradients
    backgroundGradient: string;
    
    // Animated blobs
    blob1: string;
    blob2: string;
    blob3: string;
    
    // Glassmorphism containers
    glassBg: string;
    glassBorder: string;
    
    // Input fields
    inputBg: string;
    inputBorder: string;
    inputFocus: string;
    inputPlaceholder: string;
    
    // Buttons
    primaryGradient: string;
    primaryShadow: string;
    secondaryBg: string;
    secondaryBorder: string;
    secondaryHover: string;
    
    // Text colors
    textPrimary: string;
    textSecondary: string;
    textMuted: string;
    
    // Status colors
    error: string;
    success: string;
    warning: string;
    
    // Interactive elements
    checkboxChecked: string;
    linkColor: string;
    linkHover: string;
  };
}

// Default Purple-Blue Theme (Current)
export const purpleBlueTheme: OnboardingTheme = {
  name: "Purple Blue",
  description: "Premium purple to blue gradient theme",
  colors: {
    backgroundGradient: "bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900",
    
    blob1: "bg-purple-500",
    blob2: "bg-blue-500", 
    blob3: "bg-indigo-500",
    
    glassBg: "bg-white/10",
    glassBorder: "border-white/20",
    
    inputBg: "bg-white/10",
    inputBorder: "border-white/20",
    inputFocus: "focus:border-purple-400 focus:ring-purple-400/20",
    inputPlaceholder: "placeholder:text-white/50",
    
    primaryGradient: "bg-gradient-to-r from-purple-500 to-blue-500",
    primaryShadow: "shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40",
    secondaryBg: "bg-white/10",
    secondaryBorder: "border-white/20",
    secondaryHover: "hover:bg-white/20 hover:border-white/30",
    
    textPrimary: "text-white",
    textSecondary: "text-white/70",
    textMuted: "text-white/50",
    
    error: "text-red-400",
    success: "text-green-400", 
    warning: "text-yellow-400",
    
    checkboxChecked: "data-[state=checked]:bg-purple-500 data-[state=checked]:border-purple-500",
    linkColor: "text-purple-300",
    linkHover: "hover:text-purple-200",
  }
};

// Fire Red-Orange Theme
export const fireRedOrangeTheme: OnboardingTheme = {
  name: "Fire Red Orange",
  description: "Bold fire-inspired red to orange gradient theme",
  colors: {
    backgroundGradient: "bg-gradient-to-br from-slate-900 via-red-900 to-orange-900",
    
    blob1: "bg-red-500",
    blob2: "bg-orange-500",
    blob3: "bg-pink-500",
    
    glassBg: "bg-white/10",
    glassBorder: "border-white/20",
    
    inputBg: "bg-white/10",
    inputBorder: "border-white/20", 
    inputFocus: "focus:border-red-400 focus:ring-red-400/20",
    inputPlaceholder: "placeholder:text-white/50",
    
    primaryGradient: "bg-gradient-to-r from-red-500 to-orange-500",
    primaryShadow: "shadow-lg shadow-red-500/25 hover:shadow-red-500/40",
    secondaryBg: "bg-white/10",
    secondaryBorder: "border-white/20",
    secondaryHover: "hover:bg-white/20 hover:border-white/30",
    
    textPrimary: "text-white",
    textSecondary: "text-white/70", 
    textMuted: "text-white/50",
    
    error: "text-red-300",
    success: "text-green-400",
    warning: "text-yellow-400",
    
    checkboxChecked: "data-[state=checked]:bg-red-500 data-[state=checked]:border-red-500",
    linkColor: "text-red-300",
    linkHover: "hover:text-red-200",
  }
};

// Blue Turquoise Theme
export const blueTurquoiseTheme: OnboardingTheme = {
  name: "Blue Turquoise", 
  description: "Ocean-inspired blue to turquoise gradient theme",
  colors: {
    backgroundGradient: "bg-gradient-to-br from-slate-900 via-blue-900 to-cyan-900",
    
    blob1: "bg-blue-500",
    blob2: "bg-cyan-500",
    blob3: "bg-teal-500",
    
    glassBg: "bg-white/10",
    glassBorder: "border-white/20",
    
    inputBg: "bg-white/10",
    inputBorder: "border-white/20",
    inputFocus: "focus:border-cyan-400 focus:ring-cyan-400/20", 
    inputPlaceholder: "placeholder:text-white/50",
    
    primaryGradient: "bg-gradient-to-r from-blue-500 to-cyan-500",
    primaryShadow: "shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40",
    secondaryBg: "bg-white/10",
    secondaryBorder: "border-white/20",
    secondaryHover: "hover:bg-white/20 hover:border-white/30",
    
    textPrimary: "text-white",
    textSecondary: "text-white/70",
    textMuted: "text-white/50",
    
    error: "text-red-400",
    success: "text-emerald-400",
    warning: "text-amber-400",
    
    checkboxChecked: "data-[state=checked]:bg-cyan-500 data-[state=checked]:border-cyan-500",
    linkColor: "text-cyan-300",
    linkHover: "hover:text-cyan-200",
  }
};

// Black Silver Theme (ShadCN inspired)
export const blackSilverTheme: OnboardingTheme = {
  name: "Black Silver",
  description: "Classic black and silver theme inspired by ShadCN",
  colors: {
    backgroundGradient: "bg-gradient-to-br from-gray-900 via-slate-900 to-black",
    
    blob1: "bg-gray-600",
    blob2: "bg-slate-600", 
    blob3: "bg-zinc-600",
    
    glassBg: "bg-white/5",
    glassBorder: "border-white/10",
    
    inputBg: "bg-white/5",
    inputBorder: "border-white/10",
    inputFocus: "focus:border-white/30 focus:ring-white/10",
    inputPlaceholder: "placeholder:text-white/40",
    
    primaryGradient: "bg-gradient-to-r from-gray-700 to-slate-600",
    primaryShadow: "shadow-lg shadow-black/25 hover:shadow-black/40",
    secondaryBg: "bg-white/5",
    secondaryBorder: "border-white/10", 
    secondaryHover: "hover:bg-white/10 hover:border-white/20",
    
    textPrimary: "text-white",
    textSecondary: "text-white/70",
    textMuted: "text-white/40",
    
    error: "text-red-400",
    success: "text-green-400",
    warning: "text-yellow-400",
    
    checkboxChecked: "data-[state=checked]:bg-white data-[state=checked]:border-white",
    linkColor: "text-white/80",
    linkHover: "hover:text-white",
  }
};

// Available themes
export const availableThemes = {
  purpleBlue: purpleBlueTheme,
  fireRedOrange: fireRedOrangeTheme, 
  blueTurquoise: blueTurquoiseTheme,
  blackSilver: blackSilverTheme,
} as const;

// Default theme (ShadCN style)
export const defaultTheme = blackSilverTheme;

// Theme type for consumers
export type ThemeName = keyof typeof availableThemes;

// Helper function to get theme
export const getTheme = (themeName?: ThemeName): OnboardingTheme => {
  return themeName ? availableThemes[themeName] : defaultTheme;
};

// Helper function to get theme classes for common UI patterns
export const getThemeClasses = (theme: OnboardingTheme) => ({
  // Common input classes
  input: `${theme.colors.inputBg} ${theme.colors.inputBorder} ${theme.colors.textPrimary} ${theme.colors.inputPlaceholder} ${theme.colors.inputFocus} backdrop-blur-sm h-12 rounded-lg`,
  
  // Common textarea classes  
  textarea: `${theme.colors.inputBg} ${theme.colors.inputBorder} ${theme.colors.textPrimary} ${theme.colors.inputPlaceholder} ${theme.colors.inputFocus} backdrop-blur-sm rounded-lg min-h-[100px] resize-none`,
  
  // Primary button classes
  primaryButton: `${theme.colors.primaryGradient} ${theme.colors.textPrimary} font-semibold rounded-lg ${theme.colors.primaryShadow} transition-all duration-200 border-0`,
  
  // Secondary button classes
  secondaryButton: `${theme.colors.secondaryBg} ${theme.colors.secondaryBorder} ${theme.colors.textPrimary} ${theme.colors.secondaryHover} rounded-lg font-medium transition-all duration-200`,
  
  // Checkbox classes
  checkbox: `border-white/30 ${theme.colors.checkboxChecked}`,
  
  // Glass container classes
  glassContainer: `${theme.colors.glassBg} ${theme.colors.glassBorder} rounded-lg p-4`,
  
  // Link classes
  link: `${theme.colors.linkColor} ${theme.colors.linkHover} underline transition-colors`,
});